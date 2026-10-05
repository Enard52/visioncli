import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";

// Destinations are configured in integrations.json (see README) or env vars; nothing is sent anywhere
// unless the user has set that destination up.

export type Destination = "file" | "slack" | "linear" | "jira";

interface Integrations {
  reportsDir?: string;
  slack?: { webhookUrl: string };
  linear?: { apiKey: string; teamId: string };
  jira?: { baseUrl: string; email: string; apiToken: string; projectKey: string; issueType?: string };
}

export const CONFIG_DIR =
  process.platform === "darwin"
    ? join(homedir(), "Library", "Application Support", "visioncli")
    : join(homedir(), ".config", "visioncli");
export const INTEGRATIONS_FILE = join(CONFIG_DIR, "integrations.json");

const expand = (p: string) => p.replace(/^~(?=\/|$)/, homedir());

async function load(): Promise<Integrations> {
  const cfg: Integrations = existsSync(INTEGRATIONS_FILE) ? JSON.parse(await readFile(INTEGRATIONS_FILE, "utf8")) : {};
  const e = process.env;
  if (e.VISIONCLI_SLACK_WEBHOOK) cfg.slack = { webhookUrl: e.VISIONCLI_SLACK_WEBHOOK };
  if (e.LINEAR_API_KEY && e.VISIONCLI_LINEAR_TEAM_ID) cfg.linear = { apiKey: e.LINEAR_API_KEY, teamId: e.VISIONCLI_LINEAR_TEAM_ID };
  if (e.JIRA_BASE_URL && e.JIRA_EMAIL && e.JIRA_API_TOKEN && e.JIRA_PROJECT_KEY) {
    cfg.jira = { baseUrl: e.JIRA_BASE_URL, email: e.JIRA_EMAIL, apiToken: e.JIRA_API_TOKEN, projectKey: e.JIRA_PROJECT_KEY };
  }
  return cfg;
}

export async function configuredDestinations(): Promise<Destination[]> {
  const cfg = await load();
  return ["file", ...(["slack", "linear", "jira"] as const).filter((d) => cfg[d])];
}

function slug(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50) || "report";
}

async function post(url: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new Error(`${new URL(url).host} responded ${res.status}: ${text.slice(0, 300)}`);
  return text;
}

/** Send a report somewhere. Returns a human-readable description of where it went (with a link when there is one). */
export async function share(dest: Destination, title: string, body: string, imagePath?: string): Promise<string> {
  const cfg = await load();
  const image = imagePath && existsSync(expand(imagePath)) ? expand(imagePath) : undefined;

  if (dest === "file") {
    const dir = expand(cfg.reportsDir ?? join(homedir(), "Documents", "visioncli-reports"));
    await mkdir(dir, { recursive: true });
    const stem = `${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}-${slug(title)}`;
    let md = `# ${title}\n\n${body}\n`;
    if (image) {
      const imgName = stem + extname(image);
      await copyFile(image, join(dir, imgName));
      md += `\n![screenshot](${imgName})\n`;
    }
    const file = join(dir, `${stem}.md`);
    await writeFile(file, md);
    return `Saved report to ${file}`;
  }

  const note = image ? `\n\n(Screenshot saved locally: ${basename(image)})` : "";

  if (dest === "slack") {
    if (!cfg.slack) throw new Error(`Slack isn't set up. Add {"slack": {"webhookUrl": "..."}} to ${INTEGRATIONS_FILE}.`);
    await post(cfg.slack.webhookUrl, { text: `*${title}*\n${body}${note}` });
    return "Posted to Slack.";
  }

  if (dest === "linear") {
    if (!cfg.linear) throw new Error(`Linear isn't set up. Add {"linear": {"apiKey": "...", "teamId": "..."}} to ${INTEGRATIONS_FILE}.`);
    const res = JSON.parse(
      await post(
        "https://api.linear.app/graphql",
        {
          query: "mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { identifier url } } }",
          variables: { input: { teamId: cfg.linear.teamId, title, description: body + note } },
        },
        { Authorization: cfg.linear.apiKey },
      ),
    );
    const issue = res?.data?.issueCreate?.issue;
    if (!issue) throw new Error(`Linear didn't create the issue: ${JSON.stringify(res?.errors ?? res).slice(0, 300)}`);
    return `Created Linear issue ${issue.identifier}: ${issue.url}`;
  }

  if (dest === "jira") {
    const j = cfg.jira;
    if (!j) throw new Error(`Jira isn't set up. Add {"jira": {"baseUrl", "email", "apiToken", "projectKey"}} to ${INTEGRATIONS_FILE}.`);
    const paragraphs = (body + note).split(/\n{2,}/).map((p) => ({ type: "paragraph", content: [{ type: "text", text: p }] }));
    const res = JSON.parse(
      await post(
        `${j.baseUrl.replace(/\/$/, "")}/rest/api/3/issue`,
        {
          fields: {
            project: { key: j.projectKey },
            issuetype: { name: j.issueType ?? "Task" },
            summary: title,
            description: { type: "doc", version: 1, content: paragraphs },
          },
        },
        { Authorization: "Basic " + Buffer.from(`${j.email}:${j.apiToken}`).toString("base64") },
      ),
    );
    return `Created Jira issue ${res.key}: ${j.baseUrl.replace(/\/$/, "")}/browse/${res.key}`;
  }

  throw new Error(`Unknown destination: ${dest}`);
}
