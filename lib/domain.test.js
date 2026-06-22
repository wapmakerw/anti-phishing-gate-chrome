const GateDomain = require("./domain");

describe("GateDomain library", () => {
  describe("normalizeHost", () => {
    test("normalizes uppercase and trailing dots", () => {
      expect(GateDomain.normalizeHost("EXAMPLE.COM.")).toBe("example.com");
      expect(GateDomain.normalizeHost("example.com")).toBe("example.com");
      expect(GateDomain.normalizeHost("")).toBe("");
      expect(GateDomain.normalizeHost(null)).toBe("");
    });
  });

  describe("hostOf", () => {
    test("extracts host from standard URLs", () => {
      expect(GateDomain.hostOf("https://example.com/path?query=1")).toBe("example.com");
      expect(GateDomain.hostOf("http://sub.example.com:8080/")).toBe("sub.example.com");
    });

    test("returns bare hostnames verbatim after normalization", () => {
      expect(GateDomain.hostOf("example.com")).toBe("example.com");
      expect(GateDomain.hostOf("SUB.EXAMPLE.COM.")).toBe("sub.example.com");
    });

    test("handles malformed/invalid URLs gracefully", () => {
      expect(GateDomain.hostOf("not-a-url")).toBe("not-a-url");
      expect(GateDomain.hostOf(null)).toBe("");
      expect(GateDomain.hostOf("")).toBe("");
    });

    test("handles unencoded spaces and malformed URLs with regex fallback", () => {
      expect(GateDomain.hostOf("https://example.com/path with spaces")).toBe("example.com");
      expect(GateDomain.hostOf("https://example.com/path?query=a b")).toBe("example.com");
      expect(GateDomain.hostOf("https://example.com:invalidport/path")).toBe("example.com");
    });
  });

  describe("confusableRisk", () => {
    test("flags labels mixing letters with look-alike digits 0/1", () => {
      expect(GateDomain.confusableRisk("g00gle.com")).not.toBeNull();
      expect(GateDomain.confusableRisk("https://paypa1.com/login")).not.toBeNull();
      expect(GateDomain.confusableRisk("amaz0n.co")).not.toBeNull();
    });

    test("flags international/punycode (homograph) hosts", () => {
      expect(GateDomain.confusableRisk("xn--80ak6aa92e.com")).not.toBeNull();
      expect(GateDomain.confusableRisk("раypal.com")).not.toBeNull();
    });

    test("does not flag ordinary hosts", () => {
      expect(GateDomain.confusableRisk("google.com")).toBeNull();
      expect(GateDomain.confusableRisk("mail.example.com")).toBeNull();
      expect(GateDomain.confusableRisk("paypal.com")).toBeNull();
    });

    test("flags IP-address literals used in place of a domain name", () => {
      expect(GateDomain.confusableRisk("192.168.0.1")).not.toBeNull();
    });

    test("does not flag benign infrastructure labels", () => {
      expect(GateDomain.confusableRisk("www.example.com")).toBeNull();
      expect(GateDomain.confusableRisk("api.example.com")).toBeNull();
      expect(GateDomain.confusableRisk("cdn.example.com")).toBeNull();
    });

    test("returns null for empty/invalid input", () => {
      expect(GateDomain.confusableRisk("")).toBeNull();
      expect(GateDomain.confusableRisk(null)).toBeNull();
    });
  });

  describe("isExternalHost", () => {
    test("identifies standard external links", () => {
      expect(GateDomain.isExternalHost("https://google.com", "example.com")).toBe(true);
      expect(GateDomain.isExternalHost("http://phishing.com/test", "https://trusted.com")).toBe(true);
    });

    test("identifies internal/same-domain links", () => {
      expect(GateDomain.isExternalHost("https://example.com/inbox", "example.com")).toBe(false);
      expect(GateDomain.isExternalHost("example.com", "example.com")).toBe(false);
    });

    test("identifies subdomains as external hosts", () => {
      // Full host matching treating subdomains as separate domains
      expect(GateDomain.isExternalHost("https://mail.google.com", "google.com")).toBe(true);
      expect(GateDomain.isExternalHost("https://google.com", "mail.google.com")).toBe(true);
      expect(GateDomain.isExternalHost("https://sub.example.com", "another.example.com")).toBe(true);
    });

    test("handles relative links correctly as internal", () => {
      expect(GateDomain.isExternalHost("/path/to/page", "example.com")).toBe(false);
      expect(GateDomain.isExternalHost("page.html", "example.com")).toBe(false);
      expect(GateDomain.isExternalHost("?query=1", "example.com")).toBe(false);
    });

    test("handles non-HTTP/HTTPS protocols as internal or invalidates", () => {
      // Non-HTTP URLs (mailto, tel, javascript, etc.) should not be treated as external web hosts to intercept
      expect(GateDomain.isExternalHost("mailto:test@example.com", "example.com")).toBe(false);
      expect(GateDomain.isExternalHost("tel:12345", "example.com")).toBe(false);
      expect(GateDomain.isExternalHost("javascript:void(0)", "example.com")).toBe(false);
      expect(GateDomain.isExternalHost("#anchor", "example.com")).toBe(false);
    });
  });
});
