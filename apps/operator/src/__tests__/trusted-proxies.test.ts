import { describe, expect, it } from "vitest";

import { _ParseTrustedProxies } from "../trusted-proxies.js";

describe("_ParseTrustedProxies — fail-closed trusted-proxy allowlist (OC-2 / CONN.4)", function _suite()
{
  describe("empty input is trust-nothing, never trust-all", function _emptyGroup()
  {
    it("treats an empty string as trust-nothing", function _emptyString()
    {
      const result = _ParseTrustedProxies("");
      expect(result.trustNothing).toBe(true);
      expect(result.cidrs).toEqual([]);
    });

    it("treats whitespace-only input as trust-nothing", function _whitespace()
    {
      const result = _ParseTrustedProxies("   ");
      expect(result.trustNothing).toBe(true);
      expect(result.cidrs).toEqual([]);
    });

    it("treats a comma-only / blank-entry string as trust-nothing", function _commasOnly()
    {
      const result = _ParseTrustedProxies(" , , ");
      expect(result.trustNothing).toBe(true);
      expect(result.cidrs).toEqual([]);
    });

    it("treats an empty array as trust-nothing", function _emptyArray()
    {
      const result = _ParseTrustedProxies([]);
      expect(result.trustNothing).toBe(true);
      expect(result.cidrs).toEqual([]);
    });
  });

  describe("valid allowlists parse to trustNothing=false", function _validGroup()
  {
    it("parses a single IPv4 CIDR", function _singleCidr()
    {
      const result = _ParseTrustedProxies("10.55.128.0/17");
      expect(result.trustNothing).toBe(false);
      expect(result.cidrs).toEqual(["10.55.128.0/17"]);
    });

    it("parses a comma-separated list and trims whitespace", function _commaList()
    {
      const result = _ParseTrustedProxies(" 10.0.0.0/8 , 192.168.1.0/24 ");
      expect(result.trustNothing).toBe(false);
      expect(result.cidrs).toEqual(["10.0.0.0/8", "192.168.1.0/24"]);
    });

    it("accepts a bare IPv4 address as a single host", function _bareIpv4()
    {
      const result = _ParseTrustedProxies("10.55.128.156");
      expect(result.trustNothing).toBe(false);
      expect(result.cidrs).toEqual(["10.55.128.156"]);
    });

    it("accepts the all-hosts /0 and an edge /32", function _edgePrefixes()
    {
      const result = _ParseTrustedProxies("0.0.0.0/0,10.0.0.1/32");
      expect(result.trustNothing).toBe(false);
      expect(result.cidrs).toEqual(["0.0.0.0/0", "10.0.0.1/32"]);
    });

    it("accepts IPv6 addresses and CIDRs", function _ipv6()
    {
      const result = _ParseTrustedProxies("fd00::/8,::1");
      expect(result.trustNothing).toBe(false);
      expect(result.cidrs).toEqual(["fd00::/8", "::1"]);
    });

    it("accepts an already-split array of entries", function _arrayInput()
    {
      const result = _ParseTrustedProxies(["10.0.0.0/8", "172.16.0.0/12"]);
      expect(result.trustNothing).toBe(false);
      expect(result.cidrs).toEqual(["10.0.0.0/8", "172.16.0.0/12"]);
    });

    it("de-duplicates repeated entries while preserving order", function _dedupe()
    {
      const result = _ParseTrustedProxies("10.0.0.0/8,10.0.0.0/8,192.168.0.0/16");
      expect(result.cidrs).toEqual(["10.0.0.0/8", "192.168.0.0/16"]);
    });
  });

  describe("malformed entries fail closed (throw) rather than silently shift trust", function _malformedGroup()
  {
    it("throws on an out-of-range IPv4 octet", function _badOctet()
    {
      expect(function _parse() { _ParseTrustedProxies("10.0.0.256/24"); })
        .toThrow(/invalid IP\/CIDR entry: "10.0.0.256\/24"/);
    });

    it("throws on an out-of-range IPv4 prefix", function _badPrefix()
    {
      expect(function _parse() { _ParseTrustedProxies("10.0.0.0/33"); }).toThrow(/invalid IP\/CIDR entry/);
    });

    it("throws on an out-of-range IPv6 prefix", function _badV6Prefix()
    {
      expect(function _parse() { _ParseTrustedProxies("fd00::/129"); }).toThrow(/invalid IP\/CIDR entry/);
    });

    it("throws on a non-numeric prefix", function _nonNumericPrefix()
    {
      expect(function _parse() { _ParseTrustedProxies("10.0.0.0/abc"); }).toThrow(/invalid IP\/CIDR entry/);
    });

    it("throws on a leading-zero octet (ambiguous)", function _leadingZero()
    {
      expect(function _parse() { _ParseTrustedProxies("10.0.0.01/24"); }).toThrow(/invalid IP\/CIDR entry/);
    });

    it("throws on more than one slash", function _doubleSlash()
    {
      expect(function _parse() { _ParseTrustedProxies("10.0.0.0/24/8"); }).toThrow(/invalid IP\/CIDR entry/);
    });

    it("throws on a too-few-octet IPv4 address", function _shortIpv4()
    {
      expect(function _parse() { _ParseTrustedProxies("10.0.0"); }).toThrow(/invalid IP\/CIDR entry/);
    });

    it("throws on garbage input", function _garbage()
    {
      expect(function _parse() { _ParseTrustedProxies("not-an-ip"); }).toThrow(/invalid IP\/CIDR entry/);
    });

    it("fails the whole list when any one entry is malformed", function _oneBadEntry()
    {
      expect(function _parse() { _ParseTrustedProxies("10.0.0.0/8, bogus ,192.168.0.0/16"); })
        .toThrow(/invalid IP\/CIDR entry: "bogus"/);
    });
  });
});
