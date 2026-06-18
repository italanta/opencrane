import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { _BuildShadowSeams } from "../../core/model-routing/shadow-seams.js";

/** Captured request bodies + the model each call targeted, keyed by call order. */
interface CapturedCall
{
  /** The URL the call was made to. */
  url: string;
  /** The parsed JSON request body. */
  body: { model: string; messages: { role: string; content: string }[] };
}

/** Build a `fetch` stub that returns a chat-completion with a given content + cost header. */
function _stubFetch(captured: CapturedCall[], content: string, costHeader: string | null)
{
  return vi.fn(async function _fetch(url: string, init: { body: string })
  {
    captured.push({ url, body: JSON.parse(init.body) });
    const headers = new Headers();
    if (costHeader !== null)
    {
      headers.set("x-litellm-response-cost", costHeader);
    }
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200, headers });
  });
}

describe("shadow-seams live runner + judge", function _suite()
{
  const ORIG = { endpoint: process.env.LITELLM_ENDPOINT, key: process.env.LITELLM_MASTER_KEY, judge: process.env.ROUTING_JUDGE_MODEL };

  beforeEach(function _setEnv()
  {
    process.env.LITELLM_ENDPOINT = "http://litellm:4000";
    process.env.LITELLM_MASTER_KEY = "master-key";
    process.env.ROUTING_JUDGE_MODEL = "neutral-judge";
  });

  afterEach(function _restoreEnv()
  {
    vi.restoreAllMocks();
    _restore("LITELLM_ENDPOINT", ORIG.endpoint);
    _restore("LITELLM_MASTER_KEY", ORIG.key);
    _restore("ROUTING_JUDGE_MODEL", ORIG.judge);
  });

  describe("ModelRunner", function _runnerSuite()
  {
    it("posts the right model + messages, parses content, reads x-litellm-response-cost", async function _runnerHappy()
    {
      const captured: CapturedCall[] = [];
      vi.stubGlobal("fetch", _stubFetch(captured, "hello world", "0.0042"));
      const { runner } = _BuildShadowSeams();

      const result = await runner!.run("gpt-test", "summarise this");

      expect(captured[0].url).toBe("http://litellm:4000/v1/chat/completions");
      expect(captured[0].body.model).toBe("gpt-test");
      expect(captured[0].body.messages).toEqual([{ role: "user", content: "summarise this" }]);
      expect(result.output).toBe("hello world");
      expect(result.costUsd).toBeCloseTo(0.0042, 6);
    });

    it("falls back to cost 0 when the cost header is absent", async function _runnerNoCost()
    {
      const captured: CapturedCall[] = [];
      vi.stubGlobal("fetch", _stubFetch(captured, "out", null));
      const { runner } = _BuildShadowSeams();

      const result = await runner!.run("m", "x");

      expect(result.costUsd).toBe(0);
    });

    it("uses an object input's messages array verbatim", async function _runnerObjectMessages()
    {
      const captured: CapturedCall[] = [];
      vi.stubGlobal("fetch", _stubFetch(captured, "ok", "0.01"));
      const { runner } = _BuildShadowSeams();
      const msgs = [{ role: "system", content: "be terse" }, { role: "user", content: "hi" }];

      await runner!.run("m", { messages: msgs });

      expect(captured[0].body.messages).toEqual(msgs);
    });

    it("JSON-stringifies a non-string, non-messages input into a single user message", async function _runnerJsonInput()
    {
      const captured: CapturedCall[] = [];
      vi.stubGlobal("fetch", _stubFetch(captured, "ok", "0.01"));
      const { runner } = _BuildShadowSeams();

      await runner!.run("m", { q: "what", n: 3 });

      expect(captured[0].body.messages).toEqual([{ role: "user", content: JSON.stringify({ q: "what", n: 3 }) }]);
    });

    it("throws on a non-OK upstream response (hard failure)", async function _runnerThrows()
    {
      vi.stubGlobal("fetch", vi.fn(async function _f() { return new Response("boom", { status: 500 }); }));
      const { runner } = _BuildShadowSeams();

      await expect(runner!.run("m", "x")).rejects.toThrow(/LiteLLM chat-completion failed \(500\)/);
    });
  });

  describe("JudgeClient", function _judgeSuite()
  {
    it("posts to ROUTING_JUDGE_MODEL and parses a {score} object", async function _judgeObject()
    {
      const captured: CapturedCall[] = [];
      vi.stubGlobal("fetch", _stubFetch(captured, '{"score": 0.82}', null));
      const { judge } = _BuildShadowSeams();

      const score = await judge!.score("in", "out", "expected");

      expect(captured[0].body.model).toBe("neutral-judge");
      expect(score).toBeCloseTo(0.82, 6);
    });

    it("parses a bare number reply", async function _judgeBare()
    {
      vi.stubGlobal("fetch", _stubFetch([], "0.5", null));
      const { judge } = _BuildShadowSeams();
      expect(await judge!.score("in", "out", null)).toBeCloseTo(0.5, 6);
    });

    it("parses a number embedded in prose", async function _judgeProse()
    {
      vi.stubGlobal("fetch", _stubFetch([], "I would rate this Score: 0.73 out of 1.", null));
      const { judge } = _BuildShadowSeams();
      expect(await judge!.score("in", "out", null)).toBeCloseTo(0.73, 6);
    });

    it("clamps out-of-range scores to [0, 1]", async function _judgeClamp()
    {
      vi.stubGlobal("fetch", _stubFetch([], '{"score": 1.7}', null));
      const { judge } = _BuildShadowSeams();
      expect(await judge!.score("in", "out", null)).toBe(1);

      vi.stubGlobal("fetch", _stubFetch([], '{"score": -0.4}', null));
      const { judge: judge2 } = _BuildShadowSeams();
      expect(await judge2!.score("in", "out", null)).toBe(0);
    });

    it("returns a penalizing 0 when no score is recoverable", async function _judgeNoScore()
    {
      vi.stubGlobal("fetch", _stubFetch([], "I cannot grade this output.", null));
      const { judge } = _BuildShadowSeams();
      expect(await judge!.score("in", "out", null)).toBe(0);
    });

    it("throws on a non-OK judge response (hard failure, not a silent 0)", async function _judgeThrows()
    {
      vi.stubGlobal("fetch", vi.fn(async function _f() { return new Response("boom", { status: 500 }); }));
      const { judge } = _BuildShadowSeams();

      await expect(judge!.score("in", "out", null)).rejects.toThrow(/500/);
    });
  });

  describe("_BuildShadowSeams gating", function _gatingSuite()
  {
    it("returns a live pair when endpoint + master key + judge model are all set", function _live()
    {
      const { judge, runner } = _BuildShadowSeams();
      expect(judge).not.toBeNull();
      expect(runner).not.toBeNull();
    });

    it("returns the null pair when LITELLM_ENDPOINT is unset", function _noEndpoint()
    {
      delete process.env.LITELLM_ENDPOINT;
      expect(_BuildShadowSeams()).toEqual({ judge: null, runner: null });
    });

    it("returns the null pair when LITELLM_MASTER_KEY is unset", function _noKey()
    {
      delete process.env.LITELLM_MASTER_KEY;
      expect(_BuildShadowSeams()).toEqual({ judge: null, runner: null });
    });

    it("returns the null pair when ROUTING_JUDGE_MODEL is unset (vendor-neutrality gate)", function _noJudge()
    {
      delete process.env.ROUTING_JUDGE_MODEL;
      expect(_BuildShadowSeams()).toEqual({ judge: null, runner: null });
    });
  });
});

/** Restore an env var to its captured original, deleting it when it was unset. */
function _restore(key: string, value: string | undefined): void
{
  if (value === undefined)
  {
    delete process.env[key];
  }
  else
  {
    process.env[key] = value;
  }
}
