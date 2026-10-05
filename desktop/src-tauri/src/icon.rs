//! The tray icon: the agent dock's round window in miniature. One arc per agent from twelve o'clock (wisteria while
//! working, blue once it has finished its turn, grey when idle); in the middle, how many need you on a persimmon disc,
//! or else how many are working; a grey ring struck through in persimmon when Marumado can't be read.

use crate::marumado::Reading;
use ab_glyph::{Font, FontRef, OutlineCurve, PxScale, ScaleFont};
use tiny_skia::{Color, FillRule, LineCap, Paint, PathBuilder, Pixmap, Stroke, Transform};

pub const SIZE: u32 = 64;

// The night palette's pens (DESIGN.md), mid enough to hold on a light or a dark tray.
const TRACK: [u8; 3] = [122, 119, 111];
const IDLE: [u8; 3] = [150, 147, 139];
const WORKING: [u8; 3] = [170, 146, 222]; // the agents' pen, wisteria
const DONE: [u8; 3] = [111, 159, 199]; // still blue: finished its turn
const SIGNAL: [u8; 3] = [224, 112, 63]; // persimmon: needs you
const GROUND: [u8; 3] = [34, 34, 31];

// The digits of Iosevka Aile Bold, the app's own face (SIL OFL, assets/OFL.txt).
const DIGITS: &[u8] = include_bytes!("../assets/iosevka-aile-bold-digits.ttf");

fn paint(rgb: [u8; 3]) -> Paint<'static> {
    let mut p = Paint::default();
    p.set_color(Color::from_rgba8(rgb[0], rgb[1], rgb[2], 255));
    p.anti_alias = true;
    p
}

/// An arc of the circle at (c, c), from `start` degrees clockwise from three o'clock, as a polyline fine enough to look round.
fn arc(c: f32, r: f32, start: f32, sweep: f32) -> Option<tiny_skia::Path> {
    let steps = (sweep.abs() / 3.0).ceil().max(4.0) as usize;
    let mut pb = PathBuilder::new();
    for i in 0..=steps {
        let a = (start + sweep * i as f32 / steps as f32).to_radians();
        let (x, y) = (c + r * a.cos(), c + r * a.sin());
        if i == 0 {
            pb.move_to(x, y)
        } else {
            pb.line_to(x, y)
        }
    }
    pb.finish()
}

fn stroke(px: &mut Pixmap, path: Option<tiny_skia::Path>, rgb: [u8; 3], width: f32) {
    if let Some(path) = path {
        let s = Stroke {
            width,
            line_cap: LineCap::Butt,
            ..Default::default()
        };
        px.stroke_path(&path, &paint(rgb), &s, Transform::identity(), None);
    }
}

fn disc(px: &mut Pixmap, c: f32, r: f32, rgb: [u8; 3]) {
    if let Some(path) = PathBuilder::from_circle(c, c, r) {
        px.fill_path(&path, &paint(rgb), FillRule::Winding, Transform::identity(), None);
    }
}

/// `text` centred on (c, c), `size` pixels high.
fn digits(px: &mut Pixmap, text: &str, c: f32, size: f32, rgb: [u8; 3]) {
    let Ok(font) = FontRef::try_from_slice(DIGITS) else { return };
    let scaled = font.as_scaled(PxScale::from(size));
    let (h, v) = (scaled.h_scale_factor(), scaled.v_scale_factor());
    let mut pb = PathBuilder::new();
    let mut x = 0.0;
    for ch in text.chars() {
        let id = font.glyph_id(ch);
        if let Some(outline) = font.outline(id) {
            let p = |pt: ab_glyph::Point| (x + pt.x * h, -pt.y * v);
            let mut at: Option<(f32, f32)> = None;
            for curve in &outline.curves {
                let (start, end) = match curve {
                    OutlineCurve::Line(a, b) | OutlineCurve::Quad(a, _, b) | OutlineCurve::Cubic(a, _, _, b) => (p(*a), p(*b)),
                };
                if at != Some(start) {
                    if at.is_some() {
                        pb.close();
                    }
                    pb.move_to(start.0, start.1);
                }
                match curve {
                    OutlineCurve::Line(_, _) => pb.line_to(end.0, end.1),
                    OutlineCurve::Quad(_, q, _) => {
                        let q = p(*q);
                        pb.quad_to(q.0, q.1, end.0, end.1)
                    }
                    OutlineCurve::Cubic(_, q, r, _) => {
                        let (q, r) = (p(*q), p(*r));
                        pb.cubic_to(q.0, q.1, r.0, r.1, end.0, end.1)
                    }
                }
                at = Some(end);
            }
            pb.close();
        }
        x += scaled.h_advance(id);
    }
    let Some(path) = pb.finish() else { return };
    let b = path.bounds();
    let shift = Transform::from_translate(c - (b.left() + b.width() / 2.0), c - (b.top() + b.height() / 2.0));
    px.fill_path(&path, &paint(rgb), FillRule::Winding, shift, None);
}

/// The icon, as straight (not premultiplied) RGBA, SIZE × SIZE.
pub fn draw(r: &Reading) -> Vec<u8> {
    let mut px = Pixmap::new(SIZE, SIZE).expect("a non-empty pixmap");
    let s = SIZE as f32;
    let c = s / 2.0;
    let (pad, width) = (s * 0.04, s * 0.1);
    let ring = |w: f32| c - pad - w / 2.0;
    if !r.error.is_empty() {
        // Nothing to read: an empty ring, struck through.
        stroke(&mut px, PathBuilder::from_circle(c, c, ring(s * 0.08)), TRACK, s * 0.08);
        let mut pb = PathBuilder::new();
        pb.move_to(s * 0.24, s * 0.76);
        pb.line_to(s * 0.76, s * 0.24);
        stroke(&mut px, pb.finish(), SIGNAL, s * 0.1);
        return rgba(&px);
    }
    if r.agents.is_empty() {
        stroke(&mut px, PathBuilder::from_circle(c, c, ring(s * 0.035)), TRACK, s * 0.035);
    }
    // Who needs you first, then who's working, finished, idle: the same order as the counts.
    let order = |status: &str| ["blocked", "working", "done", "idle"].iter().position(|s| *s == status).unwrap_or(4);
    let mut statuses: Vec<&str> = r.agents.iter().map(|a| a.status.as_str()).collect();
    statuses.sort_by_key(|s| order(s));
    let colour = |status: &str| match status {
        "blocked" => SIGNAL,
        "working" => WORKING,
        "done" => DONE,
        _ => IDLE,
    };
    let n = statuses.len();
    if n == 1 {
        stroke(&mut px, PathBuilder::from_circle(c, c, ring(width)), colour(statuses[0]), width);
    } else if n > 1 {
        let part = 360.0 / n as f32;
        let gap = (part * 0.22).max(14.0); // wide enough to count them at 16 px
        for (i, status) in statuses.iter().enumerate() {
            let start = -90.0 + i as f32 * part + gap / 2.0;
            stroke(&mut px, arc(c, ring(width), start, part - gap), colour(status), width);
        }
    }
    let (blocked, working) = (r.having("blocked").len(), r.having("working").len());
    let count = if blocked > 0 { blocked } else { working };
    if blocked > 0 {
        disc(&mut px, c, s * 0.31, SIGNAL);
    }
    if count > 0 {
        let text = count.min(99).to_string();
        let size = s * if text.len() == 1 { 0.5 } else { 0.4 };
        digits(&mut px, &text, c, size, if blocked > 0 { GROUND } else { WORKING });
    } else if n > 0 {
        disc(&mut px, c, s * 0.06, TRACK);
    }
    rgba(&px)
}

fn rgba(px: &Pixmap) -> Vec<u8> {
    px.pixels()
        .iter()
        .flat_map(|p| {
            let c = p.demultiply();
            [c.red(), c.green(), c.blue(), c.alpha()]
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::marumado::Agent;

    fn at(img: &[u8], x: u32, y: u32) -> [u8; 4] {
        let i = ((y * SIZE + x) * 4) as usize;
        [img[i], img[i + 1], img[i + 2], img[i + 3]]
    }

    fn agents(statuses: &[&str]) -> Reading {
        let agents = statuses
            .iter()
            .enumerate()
            .map(|(i, s)| Agent {
                pane_id: i.to_string(),
                status: s.to_string(),
                ..Default::default()
            })
            .collect();
        Reading {
            agents,
            ..Default::default()
        }
    }

    #[test]
    fn a_waiting_agent_puts_a_persimmon_disc_in_the_middle() {
        let img = draw(&agents(&["blocked", "working"]));
        assert_eq!(img.len(), (SIZE * SIZE * 4) as usize);
        // Beside the digit, inside the disc.
        let p = at(&img, SIZE / 2 - 14, SIZE / 2);
        assert_eq!(&p[..3], &SIGNAL);
    }

    #[test]
    fn the_count_of_working_agents_is_drawn_in_wisteria() {
        let img = draw(&agents(&["working", "working"]));
        let wisteria = img.chunks(4).filter(|p| p[3] == 255 && p[..3] == WORKING).count();
        assert!(wisteria > 100, "arcs and the digit: {wisteria}");
        assert_eq!(at(&img, 2, 2)[3], 0, "the corners stay clear");
    }

    #[test]
    fn unreadable_marumado_is_struck_through() {
        let img = draw(&Reading::failed("down"));
        assert_eq!(&at(&img, SIZE / 2, SIZE / 2)[..3], &SIGNAL);
    }
}
