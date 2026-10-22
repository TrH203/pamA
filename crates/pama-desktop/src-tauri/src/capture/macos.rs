//! macOS Accessibility: read the focused element's selected text without touching the clipboard.
//! Requires the Accessibility permission (System Settings › Privacy & Security › Accessibility).

use std::ffi::c_void;

use core_foundation::base::{CFRelease, CFTypeRef, TCFType};
use core_foundation::boolean::CFBoolean;
use core_foundation::dictionary::CFDictionary;
use core_foundation::string::{CFString, CFStringRef};

type AXUIElementRef = *const c_void;

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXUIElementCreateSystemWide() -> AXUIElementRef;
    fn AXUIElementCopyAttributeValue(
        element: AXUIElementRef,
        attribute: CFStringRef,
        value: *mut CFTypeRef,
    ) -> i32;
    fn AXIsProcessTrusted() -> bool;
    fn AXIsProcessTrustedWithOptions(options: *const c_void) -> bool;
    fn CFGetTypeID(cf: CFTypeRef) -> usize;
    fn CFStringGetTypeID() -> usize;
}

pub fn trusted() -> bool {
    unsafe { AXIsProcessTrusted() }
}

/// Ask macOS to show the Accessibility prompt (once per app).
pub fn prompt_for_trust() -> bool {
    let key = CFString::from_static_string("AXTrustedCheckOptionPrompt");
    let dict =
        CFDictionary::from_CFType_pairs(&[(key.as_CFType(), CFBoolean::true_value().as_CFType())]);
    unsafe { AXIsProcessTrustedWithOptions(dict.as_concrete_TypeRef() as *const c_void) }
}

/// Copy an attribute; the caller owns (and must release) the returned reference.
unsafe fn copy_attr(element: AXUIElementRef, name: &'static str) -> Option<CFTypeRef> {
    let attr = CFString::from_static_string(name);
    let mut out: CFTypeRef = std::ptr::null();
    let err = AXUIElementCopyAttributeValue(element, attr.as_concrete_TypeRef(), &mut out);
    (err == 0 && !out.is_null()).then_some(out)
}

unsafe fn string_of(v: CFTypeRef) -> Option<String> {
    if CFGetTypeID(v) != CFStringGetTypeID() {
        return None;
    }
    Some(CFString::wrap_under_get_rule(v as CFStringRef).to_string())
}

/// (selected text, frontmost app title)
pub fn selected_text() -> Option<(String, Option<String>)> {
    if !trusted() {
        return None;
    }
    unsafe {
        let system = AXUIElementCreateSystemWide();
        if system.is_null() {
            return None;
        }
        let app = copy_attr(system, "AXFocusedApplication");
        let app_name = app.and_then(|a| {
            let title = copy_attr(a as AXUIElementRef, "AXTitle");
            let s = title.and_then(|t| string_of(t));
            if let Some(t) = title {
                CFRelease(t);
            }
            s
        });
        let focused = copy_attr(system, "AXFocusedUIElement");
        let text = focused.and_then(|f| {
            let sel = copy_attr(f as AXUIElementRef, "AXSelectedText");
            let s = sel.and_then(|v| string_of(v));
            if let Some(v) = sel {
                CFRelease(v);
            }
            CFRelease(f);
            s
        });
        if let Some(a) = app {
            CFRelease(a);
        }
        CFRelease(system);
        text.filter(|t| !t.trim().is_empty()).map(|t| (t, app_name))
    }
}
