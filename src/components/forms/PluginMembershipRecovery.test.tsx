import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PluginMembershipError, PluginSavedUnverifiedError } from "@/lib/pluginMembership";
import { PluginMembershipRecovery } from "./PluginMembershipRecovery";

describe("PluginMembershipRecovery", () => {
  it("keeps the observed state and saved config available outside a toast", () => {
    const error = new PluginMembershipError(
      "Plugin update did not converge",
      ["plugin group-1 is missing", "remaining proxy references: none"],
      undefined,
      {
        id: "group-1",
        plugin_name: "rate_limiting",
        scope: "proxy_group",
        config: { requests: 10 },
        enabled: false,
      },
    );
    const html = renderToStaticMarkup(<PluginMembershipRecovery error={error} />);
    expect(html).toContain('role="alert"');
    expect(html).toContain("plugin group-1 is missing");
    expect(html).toContain("remaining proxy references: none");
    expect(html).toContain("Saved configuration for recovery");
    expect(html).toContain("rate_limiting");
    expect(html).toContain("requests");
    expect(html).toContain("false");
  });

  it("shows the committed configuration of a saved-but-unverified move (#610)", () => {
    const error = new PluginSavedUnverifiedError(
      "Plugin group-1 was saved with scope proxy, but its attachment could not be verified",
      ["before this save the group's members were: p1, p2"],
      {},
      {
        id: "group-1",
        plugin_name: "rate_limiting",
        scope: "proxy",
        proxy_id: "p3",
        config: { requests: 10 },
        enabled: true,
        created_at: "v0",
        updated_at: "v1",
      },
    );
    const html = renderToStaticMarkup(<PluginMembershipRecovery error={error} />);
    expect(html).toContain("members were: p1, p2");
    expect(html).toContain("Committed configuration");
    expect(html).toContain("Nothing was rolled back");
    expect(html).toContain("text-warning");
    expect(html).not.toContain("saved before the operation");
    expect(html).toContain("p3");
    expect(html).not.toContain("updated_at");
  });

  it("labels a snapshot from a later read as observed, not as the committed save", () => {
    const error = new PluginSavedUnverifiedError(
      "Plugin group-1 was saved with scope proxy (committed, not yet proven live)",
      [],
      {},
      {
        id: "group-1", plugin_name: "rate_limiting", scope: "proxy", proxy_id: "p3",
        config: { requests: 10 }, enabled: true, created_at: "v0", updated_at: "v1",
      },
      true,
    );
    const html = renderToStaticMarkup(<PluginMembershipRecovery error={error} />);
    expect(html).toContain("Configuration read after this save");
    expect(html).toContain("another operator");
    expect(html).not.toContain("Committed configuration");
  });

  it("shows the snapshot's trigger with its operands withheld, and says to re-enter them", () => {
    const trigger = {
      when: {
        all: [
          { not: { match: { header: { name: "x-skip", value: { exact: ["synthetic-real-operand"] } } } } },
          { match: { path: { prefix: ["/api/"] } } },
        ],
      },
    };
    const error = new PluginMembershipError(
      "Plugin update did not converge",
      [],
      undefined,
      { id: "p1", plugin_name: "waf", scope: "global", config: {}, enabled: true, trigger },
    );
    const html = renderToStaticMarkup(<PluginMembershipRecovery error={error} />);
    expect(html).not.toContain("synthetic-real-operand");
    // Edge's own marker, which the editor's placeholder guard recognizes.
    expect(html).toContain("[REDACTED]");
    expect(html).not.toContain("[redacted]");
    expect(html).toContain("x-skip");
    expect(html).toContain("/api/");
    expect(html).toContain("Re-enter them before reusing this configuration");
    // The error keeps the original snapshot for the plan's own use.
    expect(JSON.stringify(error.lastKnownConfig)).toContain("synthetic-real-operand");

    const plain = renderToStaticMarkup(<PluginMembershipRecovery error={new PluginMembershipError(
      "Plugin update did not converge",
      [],
      undefined,
      { id: "p1", plugin_name: "waf", scope: "global", config: {}, enabled: true, trigger: null },
    )} />);
    expect(plain).not.toContain("Re-enter them");

    // A snapshot already holding the gateway's marker keeps it as is, and says so.
    const masked = renderToStaticMarkup(<PluginMembershipRecovery error={new PluginMembershipError(
      "Plugin update did not converge",
      [],
      undefined,
      {
        id: "p1", plugin_name: "waf", scope: "global", config: {}, enabled: true,
        trigger: { when: { match: { query: { name: "q", value: { exact: ["[REDACTED]"] } } } } },
      },
    )} />);
    expect(masked).toContain("[REDACTED]");
    expect(masked).not.toContain("[redacted]");
    expect(masked).toContain("Re-enter them");
  });

  it("does not render for an unrelated error", () => {
    expect(
      renderToStaticMarkup(
        <PluginMembershipRecovery error={new Error("unrelated")} />,
      ),
    ).toBe("");
  });
});
