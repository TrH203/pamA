//! Shannon entropy, computed exactly like gitleaks: counts per character, divided by byte length.

use std::collections::HashMap;

pub fn shannon(data: &str) -> f64 {
    if data.is_empty() {
        return 0.0;
    }
    let mut counts: HashMap<char, usize> = HashMap::new();
    for c in data.chars() {
        *counts.entry(c).or_default() += 1;
    }
    let inv_len = 1.0 / data.len() as f64;
    counts
        .values()
        .map(|&n| {
            let f = n as f64 * inv_len;
            -f * f.log2()
        })
        .sum()
}

#[cfg(test)]
mod tests {
    use super::shannon;

    #[test]
    fn known_values() {
        assert_eq!(shannon(""), 0.0);
        assert_eq!(shannon("aaaa"), 0.0);
        assert!((shannon("ab") - 1.0).abs() < 1e-12);
        assert!((shannon("abcd") - 2.0).abs() < 1e-12);
    }
}
