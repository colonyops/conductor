import { buildPromptWithTemplates } from "../../../src/core/session.js";

const PRE = "You are running as a headless agent.";
const POST = "When done, open a draft PR.";
const CONTEXT = "Fix the bug in issue #42.";

describe("15 — buildPromptWithTemplates", () => {
  it("returns context unchanged when no templates are set", () => {
    expect(buildPromptWithTemplates(CONTEXT, undefined, undefined)).toBe(
      CONTEXT,
    );
  });

  it("returns undefined when no context and no templates", () => {
    expect(buildPromptWithTemplates(undefined, undefined, undefined)).toBe(
      undefined,
    );
  });

  it("prepends pre-template before context", () => {
    const result = buildPromptWithTemplates(CONTEXT, PRE, undefined);
    expect(result).toBe(`${PRE}\n\n${CONTEXT}`);
  });

  it("appends post-template after context", () => {
    const result = buildPromptWithTemplates(CONTEXT, undefined, POST);
    expect(result).toBe(`${CONTEXT}\n\n${POST}`);
  });

  it("wraps context with both templates", () => {
    const result = buildPromptWithTemplates(CONTEXT, PRE, POST);
    expect(result).toBe(`${PRE}\n\n${CONTEXT}\n\n${POST}`);
  });

  it("returns pre-template alone when context is undefined", () => {
    const result = buildPromptWithTemplates(undefined, PRE, undefined);
    expect(result).toBe(PRE);
  });

  it("returns post-template alone when context is undefined", () => {
    const result = buildPromptWithTemplates(undefined, undefined, POST);
    expect(result).toBe(POST);
  });

  it("joins pre and post with no context", () => {
    const result = buildPromptWithTemplates(undefined, PRE, POST);
    expect(result).toBe(`${PRE}\n\n${POST}`);
  });
});
