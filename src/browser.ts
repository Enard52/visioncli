import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

// Fast browser control for Chromium browsers (Brave, Chrome) through AppleScript: no extension, no CDP.
// Tab/navigation commands work out of the box; reading the page, clicking and typing use
// "execute javascript", which needs View → Developer → "Allow JavaScript from Apple Events" in the browser.

export const BROWSERS = ["Brave Browser", "Google Chrome"] as const;
export type BrowserName = (typeof BROWSERS)[number];

export interface Tab { id: string; window: number; index: number; title: string; url: string; active: boolean }
export interface Element { id: string; kind: string; text: string; href?: string; state?: string; expanded?: boolean; value?: string; options?: string[] }

const JS_HELP =
  'turn on View → Developer → "Allow JavaScript from Apple Events" in the browser (needed to read, click and type in pages)';

async function osa(script: string, timeout = 8000): Promise<string> {
  try {
    const { stdout } = await run("/usr/bin/osascript", ["-e", script], { timeout, maxBuffer: 16 * 1024 * 1024 });
    return stdout.replace(/\n$/, "");
  } catch (err: any) {
    const msg = String(err?.stderr || err?.message || err);
    if (/JavaScript through AppleScript is turned off|Allow JavaScript from Apple Events/i.test(msg)) throw new Error(`Please ${JS_HELP}.`);
    if (/Not authorized to send Apple events|-1743/.test(msg)) {
      throw new Error("Not allowed to control the browser: enable it in System Settings → Privacy & Security → Automation.");
    }
    throw new Error(msg.trim().replace(/^\d+:\d+: execution error: /, ""));
  }
}

const q = (s: string) => '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';

async function isRunning(name: string) {
  try {
    await run("/usr/bin/pgrep", ["-xq", name === "Brave Browser" ? "Brave Browser" : "Google Chrome"]);
    return true;
  } catch {
    return false;
  }
}

/** The browser to act on: the front-most supported browser, else the first one running. */
export async function pick(): Promise<BrowserName> {
  let front = "";
  try {
    const { stdout } = await run("/usr/bin/lsappinfo", ["info", "-only", "name", (await run("/usr/bin/lsappinfo", ["front"])).stdout.trim()]);
    front = /"LSDisplayName"="([^"]+)"/.exec(stdout)?.[1] ?? "";
  } catch {}
  if ((BROWSERS as readonly string[]).includes(front)) return front as BrowserName;
  for (const b of BROWSERS) if (await isRunning(b)) return b;
  throw new Error("Neither Brave nor Chrome is running.");
}

export async function frontmostIsBrowser(): Promise<boolean> {
  try {
    const { stdout } = await run("/usr/bin/lsappinfo", ["info", "-only", "name", (await run("/usr/bin/lsappinfo", ["front"])).stdout.trim()]);
    return BROWSERS.some((b) => stdout.includes(`"${b}"`));
  } catch {
    return false;
  }
}

export async function tabs(b?: BrowserName): Promise<Tab[]> {
  const browser = b ?? (await pick());
  const out = await osa(`
    set out to ""
    set sep to character id 9 -- not "tab": inside the tell block that means the browser's tab class
    set nl to character id 10
    tell application ${q(browser)}
      set wi to 0
      repeat with w in windows
        set wi to wi + 1
        set ai to active tab index of w
        set ti to 0
        repeat with t in tabs of w
          set ti to ti + 1
          set out to out & wi & sep & ti & sep & (ti = ai and wi = 1) & sep & (title of t) & sep & (URL of t) & nl
        end repeat
      end repeat
    end tell
    return out`);
  return out.split("\n").filter(Boolean).map((line) => {
    const [w, i, active, title, url] = line.split("\t");
    return { id: `t${w}.${i}`, window: Number(w), index: Number(i), active: active === "true", title: title ?? "", url: url ?? "" };
  });
}

export async function activeTab(b?: BrowserName): Promise<Tab | undefined> {
  return (await tabs(b)).find((t) => t.active);
}

export async function switchTo(tabId: string, b?: BrowserName) {
  const browser = b ?? (await pick());
  const [w, i] = tabId.replace(/^t/, "").split(".").map(Number);
  await osa(`tell application ${q(browser)}
    set active tab index of window ${w} to ${i}
    set index of window ${w} to 1
    activate
  end tell`);
}

// The tab the assistant works in: later opens navigate it instead of piling up new tabs/windows.
// Kept in a file because quick commands run as separate processes.
const AGENT_TAB = join(homedir(), "Library", "Application Support", "visioncli", "agent-tab.json");
const sameUrl = (a: string, b: string) => {
  const norm = (u: string) => u.replace(/#.*$/, "").replace(/\/+$/, "").replace(/^https?:\/\/(www\.)?/i, "").toLowerCase();
  return norm(a) === norm(b);
};

/**
 * Open a URL without spamming tabs: switch to a tab that already shows it; otherwise navigate the assistant's own tab
 * (if it's still open); otherwise make one new tab in the front window. `newTab: false` loads it in the current tab.
 */
export async function open(url: string, newTab = true, b?: BrowserName): Promise<string> {
  const browser = b ?? (await pick());
  if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) url = "https://" + url;
  const existing = (await tabs(browser).catch(() => [] as Tab[])).find((t) => sameUrl(t.url, url));
  if (existing) {
    await switchTo(existing.id, browser);
    return `Switched to the tab already showing ${url}`;
  }
  if (!newTab) {
    await osa(`tell application ${q(browser)}
      if (count of windows) = 0 then make new window
      set URL of active tab of window 1 to ${q(url)}
      activate
    end tell`);
    return `Opened ${url} in the current tab`;
  }
  let agent: { browser?: string; id?: string } = {};
  try { agent = JSON.parse(readFileSync(AGENT_TAB, "utf8")); } catch {}
  if (agent.browser === browser && agent.id) {
    const r = await osa(`tell application ${q(browser)}
      repeat with w in windows
        repeat with i from 1 to (count of tabs of w)
          if (id of tab i of w as text) is ${q(agent.id)} then
            set URL of tab i of w to ${q(url)}
            set active tab index of w to i
            set index of w to 1
            activate
            return "reused"
          end if
        end repeat
      end repeat
      return "gone"
    end tell`).catch(() => "gone");
    if (r === "reused") return `Opened ${url} (in the assistant's tab)`;
  }
  const id = await osa(`tell application ${q(browser)}
    if (count of windows) = 0 then make new window
    tell window 1 to set t to make new tab with properties {URL:${q(url)}}
    activate
    return id of t as text
  end tell`);
  try {
    mkdirSync(dirname(AGENT_TAB), { recursive: true });
    writeFileSync(AGENT_TAB, JSON.stringify({ browser, id }));
  } catch {}
  return `Opened ${url} in a new tab`;
}

export async function navigate(action: "back" | "forward" | "reload" | "close" | "new", b?: BrowserName) {
  const browser = b ?? (await pick());
  const cmd = {
    back: "go back active tab of window 1",
    forward: "go forward active tab of window 1",
    reload: "reload active tab of window 1",
    close: "close active tab of window 1",
    new: "tell window 1 to make new tab",
  }[action];
  await osa(`tell application ${q(browser)}
    ${cmd}
  end tell`);
}

/** Run JavaScript in the active tab and return its (string) result. */
export async function js(code: string, b?: BrowserName): Promise<string> {
  if (process.env.VISIONCLI_JS_DUMP) { // debug: hand the script to a checker instead of the browser
    (globalThis as any).__vcliDump?.(code);
    return "ok";
  }
  const browser = b ?? (await pick());
  return osa(`tell application ${q(browser)} to execute active tab of window 1 javascript ${q(code)}`, 10000);
}

/**
 * Page-side helpers that see into same-origin iframes/frames too (government and enterprise portals, Ext JS apps and
 * older admin panels often put the whole UI inside frames): __docs() all documents, __q/__qa query across them,
 * __rect an element's box in top-window coordinates.
 */
const FRAMES = `const __docs = () => { const out = [document];
    for (let i = 0; i < out.length && out.length < 40; i++) for (const f of out[i].querySelectorAll('iframe, frame')) {
      try { if (f.contentDocument && f.contentDocument.documentElement) out.push(f.contentDocument); } catch (e) {} }
    return out; };
  const __qa = sel => __docs().flatMap(d => [...d.querySelectorAll(sel)]);
  const __q = sel => { for (const d of __docs()) { const e = d.querySelector(sel); if (e) return e; } return null; };
  const __rect = el => { const r = el.getBoundingClientRect(); let x = r.left, y = r.top, w = el.ownerDocument.defaultView;
    while (w && w !== window && w.frameElement) { const fr = w.frameElement.getBoundingClientRect(); x += fr.left; y += fr.top; w = w.parent; }
    return { left: x, top: y, width: r.width, height: r.height }; };`;

// Tags visible, clickable elements with data-vcli ids so a later click/type can target them exactly.
const ELEMENTS_JS = `(() => {
  ${FRAMES}
  const vis = el => { const r = el.getBoundingClientRect(); const s = el.ownerDocument.defaultView.getComputedStyle(el);
    return r.width > 2 && r.height > 2 && s.visibility !== 'hidden' && s.display !== 'none' &&
      r.bottom > -200 && r.top < innerHeight + 1200; };
  // Form controls are named by their <label> (minus the control's own text, e.g. a select's options).
  const labelText = el => { const l = el.labels?.[0]; if (!l) return ''; const c = l.cloneNode(true);
    c.querySelectorAll('select, input, textarea').forEach(x => x.remove()); return c.innerText || c.textContent || ''; };
  const label = el => ((/^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName) ? el.getAttribute('aria-label') || labelText(el) : '') ||
    el.innerText || (el.type === 'checkbox' || el.type === 'radio' ? '' : el.value) || el.getAttribute('aria-label') || el.getAttribute('title') ||
    el.getAttribute('placeholder') || el.getAttribute('alt') || el.name || '').replace(/\\s+/g, ' ').trim().slice(0, 90);
  const sel = 'a[href], button, input, textarea, select, label, summary, [onclick], [aria-haspopup], [contenteditable=true], ' +
    '[role=button], [role=link], [role=tab], [role=menuitem], [role=menuitemcheckbox], [role=menuitemradio], [role=option], ' +
    '[role=checkbox], [role=switch], [role=radio], [role=combobox], [role=listbox], [role=slider], [role=treeitem]';
  const out = []; let n = 0;
  __qa('[data-vcli]').forEach(el => el.removeAttribute('data-vcli')); // ids from an earlier listing
  for (const el of __qa(sel)) {
    if (!vis(el)) continue;
    if (el.tagName === 'LABEL' && el.querySelector('input, select, textarea, button')) continue; // the control itself is listed
    const text = label(el); if (!text && el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA') continue;
    const id = 'e' + (++n); el.setAttribute('data-vcli', id);
    const role = el.getAttribute('role') || '';
    const type = (el.type || '').toLowerCase();
    let kind = el.tagName === 'A' ? 'link' : el.tagName === 'SELECT' ? 'dropdown' :
      ['checkbox', 'radio'].includes(type) || ['checkbox', 'switch', 'radio', 'menuitemcheckbox', 'menuitemradio'].includes(role) ? 'toggle' :
      role === 'combobox' || role === 'listbox' || el.hasAttribute('aria-haspopup') ? 'dropdown' :
      role === 'option' ? 'option' : role === 'slider' ? 'slider' :
      (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') ? 'field:' + (type || 'text') :
      el.isContentEditable ? 'field:editor' : el.tagName === 'LABEL' ? 'label' : 'button';
    const item = { id, kind, text: text || '(empty ' + kind + ')', href: el.href ? String(el.href).slice(0, 120) : undefined };
    if (kind === 'toggle') item.state = (el.checked ?? (el.getAttribute('aria-checked') === 'true')) ? 'on' : 'off';
    if (el.hasAttribute('aria-expanded')) item.expanded = el.getAttribute('aria-expanded') === 'true';
    if (el.tagName === 'SELECT') {
      item.text = label(el) || el.name || 'dropdown';
      item.value = el.selectedOptions[0]?.text?.trim();
      item.options = [...el.options].slice(0, 25).map(o => o.text.trim());
    }
    out.push(item);
    if (out.length >= 150) break;
  }
  return JSON.stringify(out);
})()`;

export async function elements(b?: BrowserName): Promise<Element[]> {
  return JSON.parse((await js(ELEMENTS_JS, b)) || "[]");
}

// ---- AI cursor: a faint ghost pointer that glides to the target, ripples, then acts, so you can see
// what Jev/Claude is doing. Off when ~/Library/Application Support/visioncli/ghost-off exists (menu toggle).
const GHOST_OFF = join(homedir(), "Library", "Application Support", "visioncli", "ghost-off");
const ghostOn = () => !existsSync(GHOST_OFF);

/** Page-side helper (defined once per page): window.__vcliGhost(x, y, then) moves the ghost and calls `then`. */
const GHOST_LIB = `if (!window.__vcliGhost) {
  const g = document.createElement('div');
  g.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24"><path d="M5 2.5 L5 19.5 L9.4 15.4 L12.3 21.8 L15 20.6 L12.2 14.3 L18.4 14.1 Z" fill="rgba(255,255,255,.92)" stroke="#22d3ee" stroke-width="1.5" stroke-linejoin="round"/></svg>';
  Object.assign(g.style, { position: 'fixed', left: '0', top: '0', zIndex: 2147483647, pointerEvents: 'none', opacity: '0',
    filter: 'drop-shadow(0 0 6px rgba(34,211,238,.85)) drop-shadow(0 0 2px rgba(168,85,247,.8))',
    transition: 'transform .42s cubic-bezier(.25,.8,.25,1), opacity .25s ease',
    transform: 'translate(' + innerWidth * 0.72 + 'px,' + innerHeight * 0.3 + 'px)' });
  document.documentElement.appendChild(g);
  const ripple = (x, y) => {
    const r = document.createElement('div');
    Object.assign(r.style, { position: 'fixed', left: (x - 14) + 'px', top: (y - 14) + 'px', width: '28px', height: '28px',
      borderRadius: '50%', border: '2px solid rgba(34,211,238,.9)', boxShadow: '0 0 12px rgba(168,85,247,.7)',
      zIndex: 2147483646, pointerEvents: 'none', transform: 'scale(.3)', opacity: '1', transition: 'transform .45s ease-out, opacity .45s ease-out' });
    document.documentElement.appendChild(r);
    requestAnimationFrame(() => { r.style.transform = 'scale(1.8)'; r.style.opacity = '0'; });
    setTimeout(() => r.remove(), 500);
  };
  window.__vcliGhost = (x, y, then, click = true) => {
    g.style.opacity = '0.62';
    requestAnimationFrame(() => { g.style.transform = 'translate(' + (x - 5) + 'px,' + (y - 3) + 'px)'; });
    setTimeout(() => {
      if (click) ripple(x, y);
      try { then && then(); } finally {
        clearTimeout(window.__vcliGhostHide);
        window.__vcliGhostHide = setTimeout(() => { g.style.opacity = '0'; }, 1600);
      }
    }, 450);
  };
}`;

/**
 * Page-side "real" press: custom widgets (React/Radix/MUI dropdowns, switches) often listen to pointerdown/mousedown,
 * not click, so fire the whole sequence a mouse would, at the element's center, then the native click.
 */
const PRESS_LIB = `if (!window.__vcliPress) {
  window.__vcliPress = (el) => {
    const r = el.getBoundingClientRect();
    const o = { bubbles: true, cancelable: true, composed: true, view: el.ownerDocument.defaultView, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0 };
    const P = window.PointerEvent || MouseEvent;
    el.dispatchEvent(new P('pointerover', { ...o, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
    el.dispatchEvent(new MouseEvent('mouseover', o));
    el.dispatchEvent(new P('pointerdown', { ...o, pointerId: 1, pointerType: 'mouse', isPrimary: true, buttons: 1 }));
    el.dispatchEvent(new MouseEvent('mousedown', { ...o, buttons: 1 }));
    if (el.focus) el.focus({ preventScroll: true });
    el.dispatchEvent(new P('pointerup', { ...o, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
    el.dispatchEvent(new MouseEvent('mouseup', o));
    el.click();
  };
}`;

/** Click an element by data-vcli id (from elements()) or, failing that, by its visible text. */
export async function click(target: string, b?: BrowserName): Promise<string> {
  const code = `(() => {
    ${FRAMES}
    let el = __q('[data-vcli=${JSON.stringify(target)}]');
    if (!el) {
      const want = ${JSON.stringify(target.toLowerCase())};
      el = [...__qa('a, button, label, [role=button], [role=link], [role=tab], [role=option], [role=menuitem], [role=checkbox], [role=switch], [role=radio], [role=combobox], [aria-haspopup], input[type=submit], summary')]
        .find(e => (e.innerText || e.value || e.getAttribute('aria-label') || '').toLowerCase().trim().includes(want));
    }
    if (!el) return 'NOT_FOUND';
    if (el.tagName === 'SELECT') return 'USE_SELECT';
    ${PRESS_LIB}
    const label = (el.labels?.[0]?.innerText || el.innerText || el.getAttribute('aria-label') || el.value || el.tagName).replace(/\\s+/g, ' ').trim().slice(0, 80);
    el.scrollIntoView({ block: 'center' });
    ${ghostOn() ? `${GHOST_LIB}
    const r = __rect(el);
    window.__vcliPress(el); // act now; the ghost cursor only shows where (its timers may be throttled)
    window.__vcliGhost(r.left + Math.min(r.width / 2, 48), r.top + r.height / 2, null);` : "window.__vcliPress(el);"}
    return label;
  })()`;
  const r = await js(code, b);
  if (r === "NOT_FOUND") throw new Error(`No clickable element matching "${target}".`);
  if (r === "USE_SELECT") throw new Error(`"${target}" is a native dropdown: use browser_select with the option text instead of clicking it.`);
  return r;
}

export async function type(target: string, text: string, submit = false, b?: BrowserName): Promise<string> {
  const code = `(() => {
    ${FRAMES}
    let el = __q('[data-vcli=${JSON.stringify(target)}]') || document.activeElement;
    while (el && el.contentDocument && el.contentDocument.activeElement) el = el.contentDocument.activeElement; // focus inside a frame
    if (!el || !('value' in el)) return 'NOT_FOUND';
    const text = ${JSON.stringify(text)};
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;
    const set = v => { setter ? setter.call(el, v) : (el.value = v); el.dispatchEvent(new Event('input', { bubbles: true })); };
    const finish = () => {
      set(text);
      el.dispatchEvent(new Event('change', { bubbles: true }));
      ${submit ? "if (el.form) { el.form.requestSubmit ? el.form.requestSubmit() : el.form.submit(); } else { el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); }" : ""}
    };
    el.scrollIntoView({ block: 'center' });
    ${ghostOn() ? `${GHOST_LIB}
    const r = __rect(el);
    // Commit the exact value right away so the next step never races an animation; the ghost just shows where.
    el.focus(); finish();
    window.__vcliGhost(r.left + 14, r.top + r.height / 2, null);` : "el.focus(); finish();"}
    return 'ok';
  })()`;
  const r = await js(code, b);
  if (r === "NOT_FOUND") throw new Error(`No text field "${target}".`);
  return r;
}

export async function scroll(where: "down" | "up" | "top" | "bottom", b?: BrowserName) {
  const action = {
    down: "window.scrollBy({top: innerHeight * 0.8, behavior: 'smooth'})",
    up: "window.scrollBy({top: -innerHeight * 0.8, behavior: 'smooth'})",
    top: "window.scrollTo({top: 0, behavior: 'smooth'})",
    bottom: "window.scrollTo({top: document.body.scrollHeight, behavior: 'smooth'})",
  }[where];
  const down = where === "down" || where === "bottom";
  const code = ghostOn()
    ? `(() => { ${GHOST_LIB}
        const x = innerWidth * 0.82, y = innerHeight * (${down} ? 0.35 : 0.65);
        window.__vcliGhost(x, y, () => { ${action}; window.__vcliGhost(x, innerHeight * (${down} ? 0.65 : 0.35), null, false); }, false);
        return 'ok'; })()`
    : `${action}; 'ok'`;
  await js(code, b);
}

/** Readable text of the current page (title, URL, main content), capped. */
export async function read(maxChars = 12000, b?: BrowserName): Promise<string> {
  const code = `(() => {
    ${FRAMES}
    const main = document.querySelector('main, article, [role=main]') || document.body;
    const frames = __docs().slice(1).map(d => d.body ? d.body.innerText || '' : '').filter(t => t.trim());
    const text = [main.innerText || '', ...frames].join('\\n\\n').replace(/\\n{3,}/g, '\\n\\n');
    return JSON.stringify({ title: document.title, url: location.href, selection: String(getSelection() || ''), text: text.slice(0, ${maxChars}) });
  })()`;
  const page = JSON.parse(await js(code, b));
  return `${page.title}\n${page.url}\n${page.selection ? `\nSelected text: ${page.selection}\n` : ""}\n${page.text}`;
}

/**
 * Choose an option in a dropdown. Native <select>: set the value the way React/Vue notice (native setter + input/change).
 * Custom dropdowns: press the trigger, wait for the popup to render, then press the matching [role=option]/menu item.
 */
export async function select(target: string, option: string, b?: BrowserName): Promise<string> {
  const want = JSON.stringify(option.toLowerCase().trim());
  const first = await js(`(() => {
    ${PRESS_LIB}
    ${FRAMES}
    const el = __q('[data-vcli=${JSON.stringify(target)}]');
    if (!el) return 'NOT_FOUND';
    el.scrollIntoView({ block: 'center' });
    if (el.tagName === 'SELECT') {
      const want = ${want};
      const opt = [...el.options].find(o => o.text.trim().toLowerCase() === want || o.value.toLowerCase() === want)
        || [...el.options].find(o => o.text.toLowerCase().includes(want));
      if (!opt) return 'NO_OPTION:' + [...el.options].map(o => o.text.trim()).slice(0, 30).join(' | ');
      const setter = Object.getOwnPropertyDescriptor(el.ownerDocument.defaultView.HTMLSelectElement.prototype, 'value').set;
      setter.call(el, opt.value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return 'DONE:' + opt.text.trim();
    }
    window.__vcliPress(el);
    return 'OPENED';
  })()`, b);
  if (first === "NOT_FOUND") throw new Error(`No element "${target}". Call browser_elements again.`);
  if (first.startsWith("NO_OPTION:")) throw new Error(`No option "${option}". Options: ${first.slice(10)}`);
  if (first.startsWith("DONE:")) return `Selected "${first.slice(5)}"`;
  await new Promise((r) => setTimeout(r, 350)); // popups render (and animate) after the press
  const second = await js(`(() => {
    ${PRESS_LIB}
    const want = ${want};
    const vis = e => { const r = e.getBoundingClientRect(); return r.width > 1 && r.height > 1; };
    ${FRAMES}
    const items = [...__qa('[role=option], [role=menuitem], [role=menuitemradio], [role=menuitemcheckbox], [role=treeitem], [cmdk-item], li')].filter(vis);
    const text = e => (e.innerText || e.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim();
    const hit = items.find(e => text(e).toLowerCase() === want) || items.find(e => text(e).toLowerCase().includes(want));
    if (!hit) return 'NO_OPTION:' + items.map(text).filter(Boolean).slice(0, 30).join(' | ');
    hit.scrollIntoView({ block: 'nearest' });
    window.__vcliPress(hit);
    return 'DONE:' + text(hit);
  })()`, b);
  if (second.startsWith("NO_OPTION:")) throw new Error(`Opened the dropdown but found no option "${option}". Visible: ${second.slice(10) || "(none)"}`);
  return `Selected "${second.slice(5)}"`;
}
