/* Generates data/issues.json from GitHub Project #4 (team-platform), scoped to
   the humanwork repo. READ-ONLY: it only queries the project; it never writes
   to GitHub. Run on a schedule (GitHub Action or the agent's cronjob).

   Env:
     GH_TOKEN   - token with READ access to org projects + repo read (fine-grained PAT).
     ORG        - org login (default: humanity-org)
     PROJECT    - project number (default: 4)
     REPO       - repo name to scope to (default: humanwork)
*/

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const ORG = process.env.ORG || "humanity-org";
const PROJECT = parseInt(process.env.PROJECT || "4", 10);
const REPO = process.env.REPO || "humanwork";
const TOKEN = process.env.GH_TOKEN;
const OUT = "data/issues.json";

const SLA = { legal: 3, design: 5 }; // business-day SLAs per blocked type

if (!TOKEN) {
  console.error("FATAL: GH_TOKEN not set. Need read access to org projects.");
  process.exit(1);
}

const QUERY = `
query($org:String!, $number:Int!, $cursor:String) {
  organization(login:$org) {
    projectV2(number:$number) {
      title
      items(first:100, after:$cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          fieldValues(first:30) {
            nodes {
              ... on ProjectV2ItemFieldSingleSelectValue { name field { ... on ProjectV2SingleSelectField { name } } }
              ... on ProjectV2ItemFieldDateValue { date field { ... on ProjectV2FieldCommon { name } } }
            }
          }
          content {
            ... on Issue {
              number title url state createdAt updatedAt
              repository { name }
              assignees(first:5) { nodes { login } }
              labels(first:30) { nodes { name } }
            }
          }
        }
      }
    }
  }
}`;

async function gql(cursor) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent": "hwork-dashboard",
    },
    body: JSON.stringify({ query: QUERY, variables: { org: ORG, number: PROJECT, cursor } }),
  });
  if (!res.ok) throw new Error("GraphQL HTTP " + res.status + ": " + (await res.text()));
  const json = await res.json();
  if (json.errors) throw new Error("GraphQL errors: " + JSON.stringify(json.errors));
  return json.data.organization.projectV2;
}

function detectPriority(labels, title) {
  for (const l of labels) {
    const m = l.match(/p([0-3])/i);
    if (m) return "P" + m[1];
  }
  const t = title.match(/\bP([0-3])\b|\[P([0-3])\]/i);
  if (t) return "P" + (t[1] || t[2]);
  return null;
}

function detectBlocked(labels) {
  // Normalize labels: lowercase and strip a leading "status:" prefix, so that
  // status:blocked, blocked, blocked:legal, status:blocked:design, etc. are all
  // treated uniformly (the team labels blockers as status:blocked).
  const set = labels.map((l) => l.toLowerCase().replace(/^status:/, ""));
  if (set.some((l) => l === "legal-hold" || l === "legal hold")) return { blocked: true, type: "legal" };
  const b = set.find((l) => l === "blocked" || l.startsWith("blocked:"));
  if (!b) return { blocked: false };
  const type = b.includes(":") ? b.split(":")[1].trim() : "blocked";
  return { blocked: true, type };
}

function daysSince(iso) {
  if (!iso) return null;
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
}

function pick(it) {
  return { number: it.number, title: it.title, url: it.url, owner: it.owner, priority: it.priority, status: it.status };
}

async function run() {
  let cursor = null, title = "", raw = [];
  do {
    const p = await gql(cursor);
    title = p.title;
    for (const node of p.items.nodes) {
      const c = node.content;
      if (!c || !c.repository || c.repository.name !== REPO) continue;
      if (c.state !== "OPEN") continue;
      // pull the project's Status single-select + any Blocked-since date field
      let status = "No Status", blockedSince = null;
      for (const fv of node.fieldValues.nodes) {
        if (!fv || !fv.field) continue;
        if (fv.field.name === "Status" && fv.name) status = fv.name;
        if (/blocked\s*since/i.test(fv.field.name || "") && fv.date) blockedSince = fv.date;
      }
      const labels = (c.labels?.nodes || []).map((l) => l.name);
      const owner = (c.assignees?.nodes || []).map((a) => a.login)[0] || null;
      raw.push({
        number: c.number, title: c.title, url: c.url, status, owner,
        labels, createdAt: c.createdAt, updatedAt: c.updatedAt, blockedSince,
        priority: detectPriority(labels, c.title),
      });
    }
    cursor = p.items.pageInfo.hasNextPage ? p.items.pageInfo.endCursor : null;
  } while (cursor);

  const summary = { open: raw.length, p0: 0, p1: 0, p2: 0, p3: 0 };
  const byStatus = {};
  const p0List = [], blocked = [], needsOwner = [];

  for (const it of raw) {
    if (it.priority) { const k = it.priority.toLowerCase(); if (summary[k] != null) summary[k]++; }
    byStatus[it.status] = (byStatus[it.status] || 0) + 1;

    if (it.priority === "P0") p0List.push(pick(it));

    const b = detectBlocked(it.labels);
    if (b.blocked) {
      const ageDays = daysSince(it.blockedSince || it.updatedAt);
      blocked.push({ ...pick(it), blockedType: b.type, ageDays, slaDays: SLA[b.type] ?? null,
        ageBasis: it.blockedSince ? "blocked-since" : "last-activity" });
    }

    const active = it.status !== "Backlog" && it.status !== "No Status";
    if (!it.owner && active) needsOwner.push(pick(it));
  }

  blocked.sort((a, b) => (b.ageDays ?? 0) - (a.ageDays ?? 0));
  p0List.sort((a, b) => a.number - b.number);

  const out = {
    generatedAt: new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC",
    project: { org: ORG, number: PROJECT, title, repo: REPO },
    summary, byStatus, p0List, blocked, needsOwner,
  };

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log("Wrote " + OUT + ": " + summary.open + " open, " + summary.p0 + " P0, " + blocked.length + " blocked, " + needsOwner.length + " need owner.");
}

run().catch((e) => { console.error(e); process.exit(1); });
