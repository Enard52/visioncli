import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

// Fast browser control for Chromium browsers (Brave, Chrome) through AppleScript: no extension, no CDP.
// Tab/navigation commands work out of the box; reading the page, clicking and typing use
// "execute javascript", which needs View → Developer → "Allow JavaScript from Apple Events" in the browser.

export const BROWSERS = ["Brave Browser", "Google Chrome"] as const;
export type BrowserName = (typeof BROWSERS)[number];

export interface Tab { id: string; window: number; index: number; title: string; url: string; active: boolean }
export interface Element { id: string; kind: string; text: string; href?: string }

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

export async function open(url: string, newTab = true, b?: BrowserName) {
  const browser = b ?? (await pick());
  if (!/^[a-z]+:\/\//i.test(url)) url = "https://" + url;
  await osa(
    newTab
      ? `tell application ${q(browser)}
          if (count of windows) = 0 then make new window
          tell window 1 to make new tab with properties {URL:${q(url)}}
          activate
        end tell`
      : `tell application ${q(browser)} to set URL of active tab of window 1 to ${q(url)}`,
  );
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

// Tags visible, clickable elements with data-vcli ids so a later click/type can target them exactly.
const ELEMENTS_JS = `(() => {
  const vis = el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
    return r.width > 2 && r.height > 2 && s.visibility !== 'hidden' && s.display !== 'none' &&
      r.bottom > -200 && r.top < innerHeight + 1200; };
  const label = el => (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('title') ||
    el.getAttribute('placeholder') || el.getAttribute('alt') || el.name || '').replace(/\\s+/g, ' ').trim().slice(0, 90);
  const sel = 'a[href], button, input, textarea, select, [role=button], [role=link], [role=tab], [role=menuitem], [onclick], summary';
  const out = []; let n = 0;
  for (const el of document.querySelectorAll(sel)) {
    if (!vis(el)) continue;
    const text = label(el); if (!text && el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA') continue;
    const id = 'e' + (++n); el.setAttribute('data-vcli', id);
    const kind = el.tagName === 'A' ? 'link' : (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') ? 'field:' + (el.type || 'text') :
      el.tagName === 'SELECT' ? 'dropdown' : 'button';
    out.push({ id, kind, text: text || '(empty ' + kind + ')', href: el.href ? String(el.href).slice(0, 120) : undefined });
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

/** Click an element by data-vcli id (from elements()) or, failing that, by its visible text. */
export async function click(target: string, b?: BrowserName): Promise<string> {
  const code = `(() => {
    let el = document.querySelector('[data-vcli=${JSON.stringify(target)}]');
    if (!el) {
      const want = ${JSON.stringify(target.toLowerCase())};
      el = [...document.querySelectorAll('a, button, [role=button], [role=link], [role=tab], input[type=submit], summary')]
        .find(e => (e.innerText || e.value || e.getAttribute('aria-label') || '').toLowerCase().trim().includes(want));
    }
    if (!el) return 'NOT_FOUND';
    const label = (el.innerText || el.value || el.getAttribute('aria-label') || el.tagName).replace(/\\s+/g, ' ').trim().slice(0, 80);
    el.scrollIntoView({ block: 'center' });
    ${ghostOn() ? `${GHOST_LIB}
    const r = el.getBoundingClientRect();
    window.__vcliGhost(r.left + Math.min(r.width / 2, 48), r.top + r.height / 2, () => el.click());` : "el.click();"}
    return label;
  })()`;
  const r = await js(code, b);
  if (r === "NOT_FOUND") throw new Error(`No clickable element matching "${target}".`);
  return r;
}

export async function type(target: string, text: string, submit = false, b?: BrowserName): Promise<string> {
  const code = `(() => {
    const el = document.querySelector('[data-vcli=${JSON.stringify(target)}]') || document.activeElement;
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
    const r = el.getBoundingClientRect();
    window.__vcliGhost(r.left + 14, r.top + r.height / 2, () => {
      // Type it out visibly (about half a second in total), then commit the exact value.
      el.focus();
      const step = Math.max(1, Math.ceil(text.length / 25)); let i = 0;
      const tick = setInterval(() => { i += step; if (i >= text.length) { clearInterval(tick); finish(); } else set(text.slice(0, i)); }, 20);
    });` : "el.focus(); finish();"}
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
    const main = document.querySelector('main, article, [role=main]') || document.body;
    const text = (main.innerText || '').replace(/\\n{3,}/g, '\\n\\n');
    return JSON.stringify({ title: document.title, url: location.href, selection: String(getSelection() || ''), text: text.slice(0, ${maxChars}) });
  })()`;
  const page = JSON.parse(await js(code, b));
  return `${page.title}\n${page.url}\n${page.selection ? `\nSelected text: ${page.selection}\n` : ""}\n${page.text}`;
}
