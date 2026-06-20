const SandboxDomain = require("./domain");

describe("SandboxDomain library", () => {
  describe("normalizeHost", () => {
    test("normalizes uppercase and trailing dots", () => {
      expect(SandboxDomain.normalizeHost("EXAMPLE.COM.")).toBe("example.com");
      expect(SandboxDomain.normalizeHost("example.com")).toBe("example.com");
      expect(SandboxDomain.normalizeHost("")).toBe("");
      expect(SandboxDomain.normalizeHost(null)).toBe("");
    });
  });

  describe("hostOf", () => {
    test("extracts host from standard URLs", () => {
      expect(SandboxDomain.hostOf("https://example.com/path?query=1")).toBe("example.com");
      expect(SandboxDomain.hostOf("http://sub.example.com:8080/")).toBe("sub.example.com");
    });

    test("returns bare hostnames verbatim after normalization", () => {
      expect(SandboxDomain.hostOf("example.com")).toBe("example.com");
      expect(SandboxDomain.hostOf("SUB.EXAMPLE.COM.")).toBe("sub.example.com");
    });

    test("handles malformed/invalid URLs gracefully", () => {
      expect(SandboxDomain.hostOf("not-a-url")).toBe("not-a-url");
      expect(SandboxDomain.hostOf(null)).toBe("");
      expect(SandboxDomain.hostOf("")).toBe("");
    });
  });

  describe("isExternalHost", () => {
    test("identifies standard external links", () => {
      expect(SandboxDomain.isExternalHost("https://google.com", "example.com")).toBe(true);
      expect(SandboxDomain.isExternalHost("http://phishing.com/test", "https://trusted.com")).toBe(true);
    });

    test("identifies internal/same-domain links", () => {
      expect(SandboxDomain.isExternalHost("https://example.com/inbox", "example.com")).toBe(false);
      expect(SandboxDomain.isExternalHost("example.com", "example.com")).toBe(false);
    });

    test("identifies subdomains as external hosts", () => {
      // Full host matching treating subdomains as separate domains
      expect(SandboxDomain.isExternalHost("https://mail.google.com", "google.com")).toBe(true);
      expect(SandboxDomain.isExternalHost("https://google.com", "mail.google.com")).toBe(true);
      expect(SandboxDomain.isExternalHost("https://sub.example.com", "another.example.com")).toBe(true);
    });

    test("handles relative links correctly as internal", () => {
      expect(SandboxDomain.isExternalHost("/path/to/page", "example.com")).toBe(false);
      expect(SandboxDomain.isExternalHost("page.html", "example.com")).toBe(false);
      expect(SandboxDomain.isExternalHost("?query=1", "example.com")).toBe(false);
    });

    test("handles non-HTTP/HTTPS protocols as internal or invalidates", () => {
      // Non-HTTP URLs (mailto, tel, javascript, etc.) should not be treated as external web hosts to intercept
      expect(SandboxDomain.isExternalHost("mailto:test@example.com", "example.com")).toBe(false);
      expect(SandboxDomain.isExternalHost("tel:12345", "example.com")).toBe(false);
      expect(SandboxDomain.isExternalHost("javascript:void(0)", "example.com")).toBe(false);
      expect(SandboxDomain.isExternalHost("#anchor", "example.com")).toBe(false);
    });
  });
});
