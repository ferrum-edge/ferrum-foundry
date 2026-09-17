# TLS material validation

TLS → Validate submits material to the gateway without persisting it. Like the
other TLS surfaces, validation is fleet-global and does not send a namespace
header. The [canonical Edge request and response contract](https://github.com/ferrum-edge/ferrum-edge/blob/main/openapi.yaml)
defines all six supported inputs:

| Control | Request field | Behavior |
| --- | --- | --- |
| Certificate (PEM) | `cert_pem` | Submit together with its matching private key. |
| Private Key (PEM) | `key_pem` | Submit together with its certificate chain. |
| CA Bundle (PEM) | `ca_bundle_pem` | Can be validated alone or with other material. |
| CRL (PEM) | `crl_pem` | Can be validated alone or with other material. |
| Allow expired certificates | `allow_expired` | Off by default; when checked, skips certificate `notBefore`/`notAfter` checks, including CA certificates. |
| Certificate expiry warning (days) | `cert_expiry_warning_days` | Optional non-negative whole number, default 30 at the gateway. Zero is accepted. The UI requires an exactly representable JavaScript integer. |

Blank or whitespace-only PEM fields are omitted; populated PEM values are sent
unchanged. An unchecked allow-expired option and a blank warning threshold are
omitted so the gateway applies its defaults. Invalid thresholds produce an inline
error before any request is sent. Field-specific gateway failures appear beside
the corresponding control.

Allowing expired certificates never relaxes CRL checks. A future `thisUpdate`,
missing `nextUpdate`, or reached `nextUpdate` rejects the entire CRL bundle.

The result displays the gateway's validity flag and complete `validated` object,
including certificate counts, CRL counts, and any warning details it returns.
The current Edge implementation logs certificate expiry warnings while returning
per-material validity and counts; Foundry does not infer warnings that are absent
from the response.
