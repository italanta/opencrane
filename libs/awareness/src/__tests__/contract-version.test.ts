import { describe, expect, it } from "vitest";

import { AWARENESS_CONTRACT_VERSION, ___AssertContractCompatible, ___IsContractCompatible } from "../contract-version.js";

describe("awareness contract version (P4B.1 / P4B.3 hook)", function _suite()
{
	it("is the pinned v1alpha1 contract", function _pinned()
	{
		expect(AWARENESS_CONTRACT_VERSION).toBe("awareness/v1alpha1");
	});

	it("treats same-major versions as compatible across minor bumps", function _compat()
	{
		expect(___IsContractCompatible("awareness/v1alpha1", "awareness/v1alpha2")).toBe(true);
		expect(___IsContractCompatible("awareness/v1alpha1", "awareness/v2alpha1")).toBe(false);
		expect(___IsContractCompatible("awareness/v1alpha1", "")).toBe(false);
	});

	it("asserts compatibility, throwing on a major mismatch or missing peer", function _assert()
	{
		expect(function _ok() { ___AssertContractCompatible("awareness/v1alpha9"); }).not.toThrow();
		expect(function _bad() { ___AssertContractCompatible("awareness/v2alpha1"); }).toThrow(/contract mismatch/);
		expect(function _none() { ___AssertContractCompatible(""); }).toThrow(/contract mismatch/);
	});
});
