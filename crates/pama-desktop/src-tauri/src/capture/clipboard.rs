//! The real clipboard (arboard) and keyboard (enigo).

use std::borrow::Cow;

use arboard::ImageData;
use enigo::{Direction, Enigo, Key, Keyboard as _, Settings};

use super::{Clipboard, Keyboard, Snapshot};

pub struct SystemClipboard(arboard::Clipboard);

impl SystemClipboard {
    pub fn new() -> Option<Self> {
        arboard::Clipboard::new().ok().map(Self)
    }
}

impl Clipboard for SystemClipboard {
    fn snapshot(&mut self) -> Snapshot {
        if let Ok(files) = self.0.get().file_list() {
            if !files.is_empty() {
                return Snapshot::Files(files);
            }
        }
        if let Ok(img) = self.0.get().image() {
            return Snapshot::Image {
                width: img.width,
                height: img.height,
                rgba: img.bytes.into_owned(),
            };
        }
        if let Ok(html) = self.0.get().html() {
            let alt = self.0.get().text().ok();
            return Snapshot::Html { html, alt };
        }
        match self.0.get().text() {
            Ok(t) => Snapshot::Text(t),
            Err(_) => Snapshot::Empty,
        }
    }

    fn restore(&mut self, s: &Snapshot) {
        let _ = match s {
            Snapshot::Empty => self.0.clear(),
            Snapshot::Text(t) => self.0.set().text(t.as_str()),
            Snapshot::Html { html, alt } => self.0.set().html(html.as_str(), alt.as_deref()),
            Snapshot::Image {
                width,
                height,
                rgba,
            } => self.0.set().image(ImageData {
                width: *width,
                height: *height,
                bytes: Cow::Borrowed(rgba),
            }),
            Snapshot::Files(f) => self.0.set().file_list(f),
        };
    }

    fn clear(&mut self) {
        let _ = self.0.clear();
    }

    fn text(&mut self) -> Option<String> {
        self.0.get().text().ok()
    }

    fn set_text(&mut self, text: &str) {
        let _ = self.0.set().text(text);
    }
}

pub struct SystemKeyboard(Enigo);

impl SystemKeyboard {
    pub fn new() -> Option<Self> {
        Enigo::new(&Settings::default()).ok().map(Self)
    }

    fn chord(&mut self, c: char) -> bool {
        let modifier = if cfg!(target_os = "macos") {
            Key::Meta
        } else {
            Key::Control
        };
        let ok = self.0.key(modifier, Direction::Press).is_ok()
            && self.0.key(Key::Unicode(c), Direction::Click).is_ok();
        let released = self.0.key(modifier, Direction::Release).is_ok();
        ok && released
    }
}

impl Keyboard for SystemKeyboard {
    fn copy(&mut self) -> bool {
        self.chord('c')
    }

    fn paste(&mut self) -> bool {
        self.chord('v')
    }
}
