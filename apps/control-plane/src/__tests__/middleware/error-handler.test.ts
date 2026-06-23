import type { NextFunction, Request, Response } from "express";
import { Prisma } from "@prisma/client";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import { _ErrorHandler } from "../../middleware/error-handler.js";

const log = pino({ level: "silent" });

/** A minimal Response stub recording the status + JSON body the handler emits. */
function _mockRes(): { res: Response; sent: { status?: number; body?: Record<string, unknown> } }
{
  const sent: { status?: number; body?: Record<string, unknown> } = {};
  const res = {
    status(code: number) { sent.status = code; return this; },
    json(body: Record<string, unknown>) { sent.body = body; return this; },
  } as unknown as Response;
  return { res, sent };
}

const req = { url: "/x", method: "POST" } as Request;
const next = (() => {}) as NextFunction;

describe("_ErrorHandler", function _suite()
{
  afterEach(() => { delete process.env["NODE_ENV"]; vi.restoreAllMocks(); });

  it("maps an unmapped Prisma P2002 to 409 CONFLICT with no leaked detail (any env)", function _p2002()
  {
    process.env["NODE_ENV"] = "production";
    const { res, sent } = _mockRes();
    const err = new Prisma.PrismaClientKnownRequestError("Unique constraint failed on the fields: (`name`)", { code: "P2002", clientVersion: "test" });

    _ErrorHandler(log)(err, req, res, next);

    expect(sent.status).toBe(409);
    expect(sent.body).toEqual({ error: "A resource with these unique values already exists.", code: "CONFLICT" });
    expect(JSON.stringify(sent.body)).not.toMatch(/Unique constraint|P2002/);
  });

  it("strips detail from a generic 500 in production", function _prodStrip()
  {
    process.env["NODE_ENV"] = "production";
    const { res, sent } = _mockRes();

    _ErrorHandler(log)(new Error("boom: secret internals"), req, res, next);

    expect(sent.status).toBe(500);
    expect(sent.body).toEqual({ error: "An unexpected error occurred", code: "INTERNAL_ERROR" });
    expect(sent.body).not.toHaveProperty("detail");
  });

  it("includes detail on a generic 500 outside production (debugging aid)", function _devDetail()
  {
    process.env["NODE_ENV"] = "development";
    const { res, sent } = _mockRes();

    _ErrorHandler(log)(new Error("boom"), req, res, next);

    expect(sent.status).toBe(500);
    expect(sent.body?.["detail"]).toBe("boom");
  });
});
