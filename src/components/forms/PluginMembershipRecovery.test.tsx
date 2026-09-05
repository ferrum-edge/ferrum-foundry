import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PluginMembershipError } from "@/lib/pluginMembership";
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

  it("does not render for an unrelated error", () => {
    expect(
      renderToStaticMarkup(
        <PluginMembershipRecovery error={new Error("unrelated")} />,
      ),
    ).toBe("");
  });
});
