//! Reading Marumado, and what the tray makes of it: the summary, the menu, the icon's look, the notifications.
//! Kept free of Tauri, so it can be checked without a desktop (`cargo test`).

use serde::Deserialize;
use std::collections::HashMap;
use std::time::Duration;

/// Up to this many working agents are listed in the menu itself; past it, one entry opens the card with all of them.
pub const MENU_WORKING: usize = 3;

#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
pub struct ProjectRef {
    #[serde(default)]
    pub name: String,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
pub struct Queued {
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub asking: bool,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
pub struct Agent {
    pub pane_id: String,
    #[serde(default)]
    pub source: i64,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub cwd: String,
    #[serde(default)]
    pub project: Option<ProjectRef>,
    #[serde(default)]
    pub queued: Option<Vec<Queued>>,
}

#[derive(Deserialize)]
struct Source {
    id: i64,
    name: String,
}

#[derive(Deserialize)]
struct Listing {
    #[serde(default)]
    available: bool,
    #[serde(default)]
    error: String,
    #[serde(default)]
    agents: Vec<Agent>,
    #[serde(default)]
    sources: Vec<Source>,
}

/// One look at Marumado: the agents (plain terminals aside), or why there are none.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Reading {
    pub agents: Vec<Agent>,
    pub sources: HashMap<i64, String>,
    pub error: String,
    /// The access token was refused.
    pub refused: bool,
}

impl Reading {
    pub fn failed(error: impl Into<String>) -> Self {
        Reading {
            error: error.into(),
            ..Default::default()
        }
    }

    pub fn having(&self, status: &str) -> Vec<&Agent> {
        self.agents.iter().filter(|a| a.status == status).collect()
    }
}

pub fn http() -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(8)))
        .http_status_as_error(false)
        .build()
        .into()
}

pub fn read(http: &ureq::Agent, url: &str, token: &str) -> Reading {
    let res = http
        .get(format!("{url}/api/agents"))
        .header("Authorization", format!("Bearer {token}"))
        .header("Accept", "application/json")
        .call();
    let mut res = match res {
        Ok(res) => res,
        Err(e) => return Reading::failed(format!("Can't reach Marumado at {url} ({e}).")),
    };
    match res.status().as_u16() {
        200 => {}
        401 | 403 => {
            return Reading {
                refused: true,
                ..Reading::failed("Marumado refused the access token.")
            }
        }
        code => return Reading::failed(format!("Marumado answered {code}.")),
    }
    let listing: Listing = match res.body_mut().read_json() {
        Ok(l) => l,
        Err(e) => return Reading::failed(format!("Marumado's answer can't be read ({e}).")),
    };
    if !listing.available {
        return Reading::failed(if listing.error.is_empty() {
            "Herdr is not running.".into()
        } else {
            listing.error
        });
    }
    Reading {
        agents: listing.agents.into_iter().filter(|a| a.kind != "terminal").collect(),
        sources: listing.sources.into_iter().map(|s| (s.id, s.name)).collect(),
        ..Default::default()
    }
}

/// Log in as a browser does (POST /api/auth), to check the address and the token before keeping them.
pub fn check_login(http: &ureq::Agent, url: &str, token: &str) -> Result<(), String> {
    let res = http
        .post(format!("{url}/api/auth"))
        .header("X-Marumado", "1")
        .send_json(serde_json::json!({ "token": token }));
    let mut res = res.map_err(|e| format!("Can't reach Marumado at {url} ({e})."))?;
    let status = res.status().as_u16();
    if (200..300).contains(&status) {
        return Ok(());
    }
    let detail = res
        .body_mut()
        .read_json::<serde_json::Value>()
        .ok()
        .and_then(|v| v.get("detail").and_then(|d| d.as_str()).map(str::to_owned));
    Err(match (status, detail) {
        (_, Some(detail)) => detail,
        (404, None) => format!("{url} answers, but isn't a Marumado."),
        (code, None) => format!("Marumado answered {code}."),
    })
}

/// The address as typed, made into an origin: `box:7878` → `http://box:7878`.
pub fn normalize_url(raw: &str) -> Result<String, String> {
    let raw = raw.trim().trim_end_matches('/');
    if raw.is_empty() {
        return Err("Enter Marumado's address.".into());
    }
    let full = if raw.contains("://") { raw.to_string() } else { format!("http://{raw}") };
    let parsed = url::Url::parse(&full).map_err(|_| format!("{raw} isn't an address."))?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return Err(format!("{raw} isn't an http or https address."));
    }
    Ok(parsed.origin().ascii_serialization())
}

pub fn key(a: &Agent) -> String {
    format!("{}/{}", a.source, a.pane_id)
}

pub fn name_of(a: &Agent) -> &str {
    if !a.name.is_empty() {
        &a.name
    } else if !a.kind.is_empty() {
        &a.kind
    } else {
        &a.pane_id
    }
}

/// What the agent's terminal title says it is doing (Claude Code titles it with the task), if it says more than its kind.
pub fn doing(a: &Agent) -> &str {
    let title = a.title.trim();
    let lower = title.to_lowercase();
    if title.is_empty() || lower == a.kind.to_lowercase() || lower == "claude code" {
        ""
    } else {
        title
    }
}

/// Waiting agents open their question in the inbox; the others their terminal (as the web app's agentActionHref).
pub fn agent_href(a: &Agent) -> String {
    if a.status == "blocked" {
        format!("#/m/agents/inbox/{}", key(a))
    } else {
        format!("#/m/agents/{}", key(a))
    }
}

/// The tooltip and the menu's summary line.
pub fn summary(r: &Reading) -> String {
    if !r.error.is_empty() {
        return r.error.clone();
    }
    if r.agents.is_empty() {
        return "No agents running".into();
    }
    let counts = [
        ("blocked", "needs you", "need you"),
        ("working", "working", "working"),
        ("done", "finished", "finished"),
        ("idle", "idle", "idle"),
    ];
    counts
        .iter()
        .filter_map(|(status, one, many)| {
            let n = r.having(status).len();
            (n > 0).then(|| format!("{n} {}", if n == 1 { one } else { many }))
        })
        .collect::<Vec<_>>()
        .join(" · ")
}

/// The agent's project, and the place it runs when there are several.
pub fn where_of(a: &Agent, r: &Reading) -> String {
    let mut bits = vec![];
    if let Some(p) = &a.project {
        bits.push(p.name.clone());
    }
    if r.sources.len() > 1 {
        bits.push(r.sources.get(&a.source).cloned().unwrap_or_default());
    }
    bits.retain(|b| !b.is_empty());
    bits.join(" · ")
}

/// A menu entry: name, and where. No running time: the menu is rebuilt only when what it lists changes, as GNOME
/// closes an open menu each time it is replaced (the card has the times).
pub fn agent_line(a: &Agent, r: &Reading) -> String {
    let mut line = name_of(a).to_string();
    let at = where_of(a, r);
    if !at.is_empty() {
        line += &format!(" · {at}");
    }
    if let Some(queued) = a.queued.as_ref().filter(|q| !q.is_empty()) {
        line += &format!(" · {} queued", queued.len());
        if queued[0].asking {
            line += ", next waits for your go";
        }
    }
    line
}

#[derive(Clone, Debug, PartialEq)]
pub enum Act {
    /// A line of text.
    Text,
    Rule,
    /// Open the agents' card.
    Card,
    /// Show this page (a hash route) in the app's window.
    Page(String),
}

#[derive(Clone, Debug, PartialEq)]
pub struct Entry {
    pub text: String,
    pub act: Act,
}

fn entry(text: impl Into<String>, act: Act) -> Entry {
    Entry { text: text.into(), act }
}

/// The menu's part that follows Marumado. "Show agents…" comes first: on Linux (AppIndicator) a click on the icon only
/// opens the menu, so the card is one entry away.
pub fn menu_model(r: &Reading) -> Vec<Entry> {
    let mut entries = vec![entry("Show agents…", Act::Card), entry(summary(r), Act::Text)];
    if !r.error.is_empty() {
        entries.extend([entry("", Act::Rule), entry("Open Marumado", Act::Page("#/".into()))]);
        return entries;
    }
    let (blocked, working) = (r.having("blocked"), r.having("working"));
    if !blocked.is_empty() {
        entries.extend([entry("", Act::Rule), entry("Needs you", Act::Text)]);
        entries.extend(
            blocked
                .iter()
                .map(|a| entry(format!("   {}", agent_line(a, r)), Act::Page(agent_href(a)))),
        );
    }
    if !working.is_empty() {
        entries.push(entry("", Act::Rule));
        if working.len() > MENU_WORKING {
            entries.push(entry(format!("See all {} working agents…", working.len()), Act::Card));
        } else {
            entries.push(entry("Working", Act::Text));
            entries.extend(
                working
                    .iter()
                    .map(|a| entry(format!("   {}", agent_line(a, r)), Act::Page(agent_href(a)))),
            );
        }
    }
    entries.extend([
        entry("", Act::Rule),
        entry("Agents", Act::Page("#/m/agents".into())),
        entry("Open Marumado", Act::Page("#/".into())),
    ]);
    entries
}

/// All the icon depends on: it is redrawn, and handed to the tray, only when this changes.
pub type Look = (bool, Vec<String>);

pub fn icon_look(r: &Reading) -> Look {
    let mut statuses: Vec<String> = r.agents.iter().map(|a| a.status.clone()).collect();
    statuses.sort();
    (!r.error.is_empty(), statuses)
}

/// What was last seen of each agent, to tell when one starts waiting or finishes, and since when each is working.
#[derive(Default)]
pub struct Watch {
    last: HashMap<String, String>,
    /// When each agent was first seen working, this time (milliseconds since the epoch).
    pub since: HashMap<String, u64>,
}

impl Watch {
    /// Takes a reading in, and returns the notifications it calls for: (title, body).
    pub fn observe(&mut self, r: &Reading, now_ms: u64) -> Vec<(String, String)> {
        if !r.error.is_empty() {
            return vec![];
        }
        let mut news = vec![];
        for a in &r.agents {
            let k = key(a);
            if a.status == "working" {
                self.since.entry(k.clone()).or_insert(now_ms);
            } else {
                self.since.remove(&k);
            }
            let Some(was) = self.last.get(&k) else { continue };
            if *was == a.status {
                continue;
            }
            let body = if doing(a).is_empty() { where_of(a, r) } else { doing(a).to_string() };
            if a.status == "blocked" {
                news.push((format!("{} needs you", name_of(a)), body));
            } else if matches!(a.status.as_str(), "done" | "idle") && was == "working" {
                news.push((format!("{} finished its turn", name_of(a)), body));
            }
        }
        self.since.retain(|k, _| r.agents.iter().any(|a| key(a) == *k));
        self.last = r.agents.iter().map(|a| (key(a), a.status.clone())).collect();
        news
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn agent(pane: &str, status: &str) -> Agent {
        Agent {
            pane_id: pane.into(),
            name: format!("a{pane}"),
            kind: "claude".into(),
            status: status.into(),
            cwd: "/p".into(),
            ..Default::default()
        }
    }

    fn texts(r: &Reading) -> Vec<String> {
        menu_model(r).into_iter().map(|e| e.text.trim().to_string()).collect()
    }

    #[test]
    fn up_to_three_working_agents_are_listed_in_the_menu() {
        let mut agents: Vec<Agent> = (0..MENU_WORKING).map(|i| agent(&i.to_string(), "working")).collect();
        agents.push(agent("9", "idle"));
        let r = Reading {
            agents,
            ..Default::default()
        };
        let t = texts(&r);
        assert_eq!(t[0], "Show agents…");
        assert_eq!(t[1], "3 working · 1 idle");
        assert!(t.contains(&"a0".to_string()));
        assert_eq!(menu_model(&r).iter().filter(|e| e.act == Act::Card).count(), 1);
    }

    #[test]
    fn past_three_one_entry_opens_the_card() {
        let r = Reading {
            agents: (0..=MENU_WORKING).map(|i| agent(&i.to_string(), "working")).collect(),
            ..Default::default()
        };
        let cards: Vec<String> = menu_model(&r).into_iter().filter(|e| e.act == Act::Card).map(|e| e.text).collect();
        assert_eq!(cards, vec!["Show agents…", "See all 4 working agents…"]);
    }

    #[test]
    fn the_menu_is_the_same_between_readings_of_the_same_agents() {
        // GNOME closes an open menu when it is replaced: nothing in it may move on its own (no running times).
        let r = || Reading {
            agents: vec![agent("1", "working"), agent("2", "blocked")],
            ..Default::default()
        };
        assert_eq!(menu_model(&r()), menu_model(&r()));
    }

    #[test]
    fn a_waiting_agent_opens_its_question() {
        let r = Reading {
            agents: vec![agent("w1:p2", "blocked")],
            ..Default::default()
        };
        assert!(menu_model(&r).contains(&Entry {
            text: "   aw1:p2".into(),
            act: Act::Page("#/m/agents/inbox/0/w1:p2".into())
        }));
    }

    #[test]
    fn an_error_says_why_and_offers_marumado() {
        let r = Reading::failed("Can't reach Marumado at http://x (refused).");
        assert_eq!(
            texts(&r),
            vec!["Show agents…", "Can't reach Marumado at http://x (refused).", "", "Open Marumado"]
        );
        assert!(icon_look(&r).0);
    }

    #[test]
    fn notifies_when_one_starts_waiting_or_finishes() {
        let mut w = Watch::default();
        let r = |a: &str, b: &str| Reading {
            agents: vec![agent("1", a), agent("2", b)],
            ..Default::default()
        };
        assert!(w.observe(&r("working", "working"), 1).is_empty(), "the first reading only learns");
        assert_eq!(w.since.get("0/1"), Some(&1));
        let news = w.observe(&r("blocked", "done"), 2);
        assert_eq!(
            news.iter().map(|n| n.0.as_str()).collect::<Vec<_>>(),
            vec!["a1 needs you", "a2 finished its turn"]
        );
        assert!(w.since.is_empty());
        assert!(w.observe(&r("blocked", "idle"), 3).is_empty(), "done to idle is no news");
    }

    #[test]
    fn addresses_are_made_into_origins() {
        assert_eq!(normalize_url(" 127.0.0.1:7878/ ").unwrap(), "http://127.0.0.1:7878");
        assert_eq!(normalize_url("https://box.lan/").unwrap(), "https://box.lan");
        assert!(normalize_url("ftp://box").is_err());
        assert!(normalize_url("").is_err());
    }

    #[test]
    fn summary_counts_in_words() {
        let r = Reading {
            agents: vec![agent("1", "blocked"), agent("2", "blocked"), agent("3", "done")],
            ..Default::default()
        };
        assert_eq!(summary(&r), "2 need you · 1 finished");
        assert_eq!(summary(&Reading::default()), "No agents running");
    }
}
