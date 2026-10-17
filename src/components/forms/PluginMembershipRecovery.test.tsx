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

  it("does not render for an unrelated error", () => {
    expect(
      renderToStaticMarkup(
        <PluginMembershipRecovery error={new Error("unrelated")} />,
      ),
    ).toBe("");
  });
});
