//! Clipboard behaviour of the hotkey flow (Constitution III, FR-021/022): the selection is copied,
//! the owner's clipboard comes back, nothing is sent, and only the question is kept.

use std::cell::RefCell;
use std::rc::Rc;
use std::time::Duration;

use pama_desktop_lib::capture::{
    capture, capture_via_clipboard, copy_draft, paste_draft, Clipboard, Clock, Keyboard, Method,
    Snapshot,
};

/// A desktop with one focused app: shared clipboard, the app's selection, what it received.
#[derive(Default)]
struct Desk {
    clipboard: Snapshot,
    restores: usize,
    selection: Option<String>,
    pasted: Vec<String>,
    keys: Vec<&'static str>,
}

#[derive(Clone, Default)]
struct World(Rc<RefCell<Desk>>);

struct Clip(World);
struct App(World);

impl Clipboard for Clip {
    fn snapshot(&mut self) -> Snapshot {
        self.0 .0.borrow().clipboard.clone()
    }
    fn restore(&mut self, s: &Snapshot) {
        let mut d = self.0 .0.borrow_mut();
        d.restores += 1;
        d.clipboard = s.clone();
    }
    fn clear(&mut self) {
        self.0 .0.borrow_mut().clipboard = Snapshot::Empty;
    }
    fn text(&mut self) -> Option<String> {
        match &self.0 .0.borrow().clipboard {
            Snapshot::Text(t) => Some(t.clone()),
            Snapshot::Html { alt, .. } => alt.clone(),
            _ => None,
        }
    }
    fn set_text(&mut self, text: &str) {
        self.0 .0.borrow_mut().clipboard = Snapshot::Text(text.into());
    }
}

impl Keyboard for App {
    fn copy(&mut self) -> bool {
        let mut d = self.0 .0.borrow_mut();
        d.keys.push("copy");
        if let Some(s) = d.selection.clone() {
            d.clipboard = Snapshot::Text(s);
        }
        true
    }
    fn paste(&mut self) -> bool {
        let mut d = self.0 .0.borrow_mut();
        d.keys.push("paste");
        let t = match &d.clipboard {
            Snapshot::Text(t) => t.clone(),
            _ => String::new(),
        };
        d.pasted.push(t);
        true
    }
}

#[derive(Default)]
struct FakeClock(Duration);

impl Clock for FakeClock {
    fn sleep(&mut self, d: Duration) {
        self.0 += d;
    }
}

fn world(clipboard: Snapshot, selection: Option<&str>) -> (World, Clip, App) {
    let w = World::default();
    {
        let mut d = w.0.borrow_mut();
        d.clipboard = clipboard;
        d.selection = selection.map(String::from);
    }
    (w.clone(), Clip(w.clone()), App(w))
}

fn sentinel() -> Snapshot {
    Snapshot::Text("CLIPBOARD-SENTINEL".into())
}

#[test]
fn captures_the_selection_and_restores_the_clipboard() {
    let (w, mut cb, mut app) = world(sentinel(), Some("  Refund có hoàn phí ship không?  "));
    let mut clock = FakeClock::default();
    let got = capture_via_clipboard(&mut cb, &mut app, &mut clock);
    assert_eq!(got.as_deref(), Some("Refund có hoàn phí ship không?"));
    assert_eq!(w.0.borrow().clipboard, sentinel());
    assert!(clock.0 <= Duration::from_millis(300));
}

#[test]
fn nothing_selected_gives_an_empty_question_and_restores_within_300ms() {
    let (w, mut cb, mut app) = world(sentinel(), None);
    let mut clock = FakeClock::default();
    let r = capture(|| None, &mut cb, &mut app, &mut clock);
    assert_eq!(r.text, None);
    assert_eq!(r.method, Method::None);
    assert_eq!(w.0.borrow().clipboard, sentinel());
    assert_eq!(clock.0, Duration::from_millis(300));
}

#[test]
fn accessibility_capture_never_touches_the_clipboard() {
    let (w, mut cb, mut app) = world(sentinel(), Some("other"));
    let mut clock = FakeClock::default();
    let r = capture(
        || {
            Some((
                "What did we decide about refunds?".into(),
                Method::Ax,
                Some("Slack".into()),
            ))
        },
        &mut cb,
        &mut app,
        &mut clock,
    );
    assert_eq!(r.method, Method::Ax);
    assert_eq!(r.app.as_deref(), Some("Slack"));
    assert!(
        w.0.borrow().keys.is_empty(),
        "no keystrokes when accessibility worked"
    );
    assert_eq!(w.0.borrow().restores, 0);
}

#[test]
fn paste_inserts_the_draft_never_sends_and_restores_after_500ms() {
    let (w, mut cb, mut app) = world(sentinel(), None);
    let mut clock = FakeClock::default();
    assert!(paste_draft(
        &mut cb,
        &mut app,
        &mut clock,
        "Không, phí ship không được hoàn."
    ));
    let d = w.0.borrow();
    assert_eq!(
        d.pasted,
        vec!["Không, phí ship không được hoàn.".to_string()]
    );
    assert_eq!(d.keys, vec!["paste"], "only paste; never Enter or send");
    assert_eq!(clock.0, Duration::from_millis(500));
    assert_eq!(d.clipboard, sentinel());
}

#[test]
fn rich_clipboard_content_is_restored() {
    let image = Snapshot::Image {
        width: 2,
        height: 1,
        rgba: vec![255; 8],
    };
    let (w, mut cb, mut app) = world(image.clone(), Some("question"));
    capture_via_clipboard(&mut cb, &mut app, &mut FakeClock::default());
    assert_eq!(w.0.borrow().clipboard, image);
}

#[test]
fn copy_leaves_the_draft_on_the_clipboard() {
    let (w, mut cb, _) = world(sentinel(), None);
    copy_draft(&mut cb, "draft");
    assert_eq!(w.0.borrow().clipboard, Snapshot::Text("draft".into()));
}
