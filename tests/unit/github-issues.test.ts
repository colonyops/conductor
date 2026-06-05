import { issueSlug } from "../../src/plugins/github-issues.js";

describe("issueSlug", () => {
  it("produces gh-{number}-{slug} format", () => {
    expect(issueSlug(15, "docs: user getting-started guide")).toBe("gh-15-docs-user-getting-started-guide");
  });

  it("truncates to 40 chars by default", () => {
    const result = issueSlug(34, "feat: adopt hive v0.53 session lifecycle");
    expect(result.length).toBeLessThanOrEqual(40);
    expect(result).toBe("gh-34-feat-adopt-hive-v0-53-session-life");
  });

  it("strips trailing hyphen after truncation", () => {
    // Craft a title that would leave a trailing hyphen at the cut point
    const result = issueSlug(1, "a".repeat(40));
    expect(result).not.toMatch(/-$/);
  });

  it("lowercases the title", () => {
    expect(issueSlug(5, "Fix: UPPER CASE TITLE")).toBe("gh-5-fix-upper-case-title");
  });

  it("replaces special characters with hyphens", () => {
    expect(issueSlug(16, "fix: hook signal resolution fails!")).toBe("gh-16-fix-hook-signal-resolution-fails");
  });

  it("collapses multiple special chars into single hyphen", () => {
    expect(issueSlug(7, "feat: foo -- bar")).toBe("gh-7-feat-foo-bar");
  });

  it("respects custom maxLen", () => {
    const result = issueSlug(99, "some very long title that exceeds the limit", 20);
    expect(result.length).toBeLessThanOrEqual(20);
    expect(result).not.toMatch(/-$/);
  });

  it("produces only lowercase alphanumeric and hyphens", () => {
    const result = issueSlug(42, "feat: [v2] adopt @scope/pkg & update deps!");
    expect(result).toMatch(/^[a-z0-9-]+$/);
  });
});
