# Example wallets for bitcoin-wallet-check.html

Freshly created, empty wallets to try [../bitcoin-wallet-check.html](../bitcoin-wallet-check.html)
with (the page's demo selector loads them). Their private keys are public by virtue of being in this
repository: never send anything to them.

| File | Made with | Format |
|---|---|---|
| `example-descriptor.dat` | Bitcoin Core 31.1, `createwallet` (`-keypool=10`) | SQLite descriptor wallet, unencrypted |
| `example-encrypted.dat` | Bitcoin Core 31.1, `createwallet` with passphrase `satoshi` | SQLite descriptor wallet, encrypted (also used by the wrong-passphrase demo) |
| `example-watchonly.dat` | Bitcoin Core 31.1, `createwallet disable_private_keys=true`, `importdescriptors` of another wallet's public descriptors | SQLite descriptor wallet, watch-only |
| `example-signet.dat` | Bitcoin Core 31.1, `createwallet` on `-chain=signet` | SQLite descriptor wallet, signet |
| `example-legacy.dat` | Bitcoin Core 26.2, `createwallet descriptors=false` (`-keypool=5`) | Berkeley DB legacy wallet, unencrypted; the page migrates it with `migratewallet` |

All were exported with `backupwallet` from a node started with `-networkactive=0 -connect=0`.
