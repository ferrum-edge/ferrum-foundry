import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MaskedSecretRefusal } from "./MaskedSecretRefusal";
import { MaskedSecretWriteError } from "@/api/maskedSecrets";
import { RedactedWriteError } from "@/api/secretRedaction";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

async function render(error: unknown) {
  await act(async () => root.render(<MaskedSecretRefusal error={error} />));
}

function listed(): string[] {
  return [...host.querySelectorAll("li code")].map((code) => code.textContent ?? "");
}

describe("MaskedSecretRefusal", () => {
  it("lists the field pointers from Edge's 400 as written", async () => {
    const refused = new RedactedWriteError(
      "Request failed with status code 400 Bad Request",
      new Response(null, { status: 400 }),
      {
        error:
          "Plugin config field(s) /config/endpoint_url, /config/custom_headers/x-team carry the " +
          "redaction placeholder that 'operator' reads return in place of the stored secret; " +
          "writing it back would replace the secret with the placeholder.",
      },
      "HTTPError",
    );
    await render(new Error("Plugin update did not converge", { cause: refused }));

    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      "Ferrum Edge refused this save",
    );
    expect(host.textContent).toContain("'operator' reads");
    expect(listed()).toEqual(["/config/endpoint_url", "/config/custom_headers/x-team"]);
  });

  it("reports Foundry's own refusal", async () => {
    await render(new MaskedSecretWriteError("not sent", ["/service_discovery/consul/token"]));
    expect(host.textContent).toContain("Foundry did not send this save");
    expect(listed()).toEqual(["/service_discovery/consul/token"]);
  });

  it("renders nothing for any other failure", async () => {
    await render(new Error("Request failed with status code 500"));
    expect(host.innerHTML).toBe("");
    await render(null);
    expect(host.innerHTML).toBe("");
  });
});
