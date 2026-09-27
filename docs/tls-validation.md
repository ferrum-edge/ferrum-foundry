# TLS material validation

TLS → Validate sends PEM material to the gateway's `POST /admin/tls/validate`
without storing it. Like the other TLS surfaces, it is fleet-global and sends no
namespace header. It needs the operator role or higher. The
[Edge OpenAPI contract](https://github.com/ferrum-edge/ferrum-edge/blob/main/openapi.yaml)
defines the request and response.

| Control | Request field | Behavior |
| --- | --- | --- |
| Certificate (PEM) | `cert_pem` | Submit together with its private key. |
| Private Key (PEM) | `key_pem` | Submit together with its certificate. |
| CA Bundle (PEM) | `ca_bundle_pem` | Can be validated alone or with other material. |
| CRL (PEM) | `crl_pem` | Can be validated alone or with other material. |
| Allow expired certificates | `allow_expired` | Off by default. When checked, skips certificate `notBefore`/`notAfter` checks, including on CA certificates. |
| Certificate expiry warning (days) | `cert_expiry_warning_days` | Optional non-negative whole number; the gateway default is 30. Zero is accepted. |

Submit at least one kind of material. Foundry builds the request like this:

- Blank or whitespace-only PEM fields are left out. Populated PEM values are sent
  unchanged.
- An unchecked allow-expired box and a blank warning threshold are left out, so
  the gateway applies its defaults.
- A threshold that is negative, fractional, or not a safe JavaScript integer
  shows an inline error, and nothing is sent.

When the gateway rejects a specific field (`field: message`), the error appears
under that control. Other failures appear as a toast. Submitted secrets are
removed from any reported error.

Allowing expired certificates never relaxes CRL checks. A CRL with a future
`thisUpdate`, a missing `nextUpdate`, or a `nextUpdate` that has passed rejects
the whole CRL bundle.

The result shows the gateway's `valid` flag and its full `validated` object as
returned. Foundry does not compute expiry warnings itself; it shows only what
the response contains.
