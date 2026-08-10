import { describe, expect, it, vi } from "vitest";
import { SellerRequestGovernor } from "../src/seller-api.js";

describe("seller request governor", () => {
  it("bounds global concurrency and reports sanitized aggregate metrics", async () => {
    const releases: (() => void)[] = [];
    let active = 0;
    let peak = 0;
    const fetchImplementation = vi.fn(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise<void>((resolvePromise) => {
        releases.push(resolvePromise);
      });
      active -= 1;
      return new Response(null, { status: 200 });
    });
    const governor = new SellerRequestGovernor({
      maximumConcurrency: 2,
      minimumStartSpacingMs: 0,
      fetch: fetchImplementation,
      now: () => new Date("2026-08-10T12:00:00.000Z"),
    });

    const requests = [1, 2, 3, 4].map((id) =>
      governor.fetch(`https://example.test/private/${String(id)}`),
    );
    await vi.waitFor(() =>
      expect(fetchImplementation).toHaveBeenCalledTimes(2),
    );
    expect(governor.snapshot()).toMatchObject({
      requestAttempts: 2,
      inFlightRequests: 2,
      queuedRequests: 2,
      peakInFlightRequests: 2,
    });

    releases.shift()?.();
    await vi.waitFor(() =>
      expect(fetchImplementation).toHaveBeenCalledTimes(3),
    );
    releases.shift()?.();
    await vi.waitFor(() =>
      expect(fetchImplementation).toHaveBeenCalledTimes(4),
    );
    releases.splice(0).forEach((release) => release());
    await Promise.all(requests);

    expect(peak).toBe(2);
    expect(governor.snapshot()).toEqual({
      maximumConcurrency: 2,
      minimumStartSpacingMs: 0,
      requestAttempts: 4,
      successfulResponses: 4,
      errorResponses: 0,
      networkFailures: 0,
      abortedRequests: 0,
      inFlightRequests: 0,
      queuedRequests: 0,
      peakInFlightRequests: 2,
      lastStartedAt: "2026-08-10T12:00:00.000Z",
      lastCompletedAt: "2026-08-10T12:00:00.000Z",
    });
    expect(JSON.stringify(governor.snapshot())).not.toContain("/private/");
  });

  it("removes an aborted queued request without consuming a slot", async () => {
    let release: (() => void) | undefined;
    const fetchImplementation = vi.fn(
      () =>
        new Promise<Response>((resolvePromise) => {
          release = () => resolvePromise(new Response(null, { status: 200 }));
        }),
    );
    const governor = new SellerRequestGovernor({
      maximumConcurrency: 1,
      minimumStartSpacingMs: 0,
      fetch: fetchImplementation,
    });
    const first = governor.fetch("https://example.test/first");
    const controller = new AbortController();
    const second = governor.fetch("https://example.test/second", {
      signal: controller.signal,
    });
    controller.abort();

    await expect(second).rejects.toMatchObject({ name: "AbortError" });
    expect(governor.snapshot().queuedRequests).toBe(0);
    release?.();
    await first;
    expect(fetchImplementation).toHaveBeenCalledOnce();
  });

  it("counts HTTP and transport failures and releases their slots", async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockRejectedValueOnce(new Error("synthetic network failure"));
    const governor = new SellerRequestGovernor({
      maximumConcurrency: 1,
      minimumStartSpacingMs: 0,
      fetch: fetchImplementation,
    });

    const response = await governor.fetch("https://example.test/http-error");
    await expect(
      governor.fetch("https://example.test/network-error"),
    ).rejects.toThrow("synthetic network failure");

    expect(response.status).toBe(503);
    expect(governor.snapshot()).toMatchObject({
      requestAttempts: 2,
      successfulResponses: 0,
      errorResponses: 1,
      networkFailures: 1,
      abortedRequests: 0,
      inFlightRequests: 0,
      queuedRequests: 0,
      peakInFlightRequests: 1,
    });
  });

  it("holds a slot until the response body finishes", async () => {
    let finishBody: (() => void) | undefined;
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          new ReadableStream<Uint8Array>({
            start: (controller) => {
              controller.enqueue(new Uint8Array([1]));
              finishBody = () => controller.close();
            },
          }),
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    const governor = new SellerRequestGovernor({
      maximumConcurrency: 1,
      minimumStartSpacingMs: 0,
      fetch: fetchImplementation,
    });

    const first = await governor.fetch("https://example.test/stream");
    const second = governor.fetch("https://example.test/next");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
    expect(fetchImplementation).toHaveBeenCalledOnce();
    expect(governor.snapshot()).toMatchObject({
      inFlightRequests: 1,
      queuedRequests: 1,
      successfulResponses: 0,
    });

    const bytes = first.arrayBuffer();
    finishBody?.();
    await bytes;
    await second;

    expect(fetchImplementation).toHaveBeenCalledTimes(2);
    expect(governor.snapshot()).toMatchObject({
      inFlightRequests: 0,
      queuedRequests: 0,
      successfulResponses: 2,
    });
  });

  it("spaces actual network starts even when concurrency is available", async () => {
    const starts: number[] = [];
    const fetchImplementation = vi.fn(() => {
      starts.push(Date.now());
      return Promise.resolve(new Response(null, { status: 200 }));
    });
    const governor = new SellerRequestGovernor({
      maximumConcurrency: 2,
      minimumStartSpacingMs: 20,
      fetch: fetchImplementation,
    });

    await Promise.all([
      governor.fetch("https://example.test/first"),
      governor.fetch("https://example.test/second"),
    ]);

    expect(starts).toHaveLength(2);
    expect((starts[1] ?? 0) - (starts[0] ?? 0)).toBeGreaterThanOrEqual(15);
  });
});
