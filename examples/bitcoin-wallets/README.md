# Example wallets for bitcoin-wallet-check.html

Two freshly created, empty mainnet wallets to try [../bitcoin-wallet-check.html](../bitcoin-wallet-check.html)
with (the page links to them). Their private keys are public by virtue of being in this
repository: never send anything to them.

| File | Made with | Format |
|---|---|---|
| `example-descriptor.dat` | Bitcoin Core 31.1, `createwallet` (`-keypool=10`) | SQLite descriptor wallet, unencrypted |
| `example-legacy.dat` | Bitcoin Core 26.2, `createwallet descriptors=false` (`-keypool=5`) | Berkeley DB legacy wallet, unencrypted; the page migrates it with `migratewallet` |

Both were exported with `backupwallet` from a node started with `-networkactive=0 -connect=0`.
