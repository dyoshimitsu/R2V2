# R2V2

[日本語](README.ja.md)

R2V2 syncs an Obsidian vault between desktops through a Cloudflare R2 bucket. Everything that reaches the bucket is encrypted on your device first: file contents, file names and modification times. Encryption cannot be turned off.

The name stands for "R2 Vault to Vault", and is read the way R2-D2 is. The plugin ID, `artoo-veetoo`, follows from that.

- **Account required**: you need your own Cloudflare account with an R2 bucket and an API token. R2 has a free tier; usage beyond it is billed by Cloudflare.
- **Network use**: the plugin talks only to the S3 API endpoint of your R2 account (`https://<account-id>.r2.cloudflarestorage.com`, or the endpoint you enter) to list, upload, download and delete the encrypted copies of your files. It contacts no other service.
- **No telemetry**, no ads, and no access to files outside the vault.
- **Desktop only** (Linux and macOS), Obsidian 1.11.4 or later. The interface follows Obsidian's language setting and is available in English and Japanese.

## What the bucket can see

Encrypting file contents is not enough. A file named `Journal/Thinking about changing jobs.md` says a lot before anyone reads a word of it, and so does the time it was last edited.

R2V2 therefore encrypts paths and modification times as well. Someone looking into the bucket sees only:

- `r2v2.json`, which holds the key-derivation parameters and a salt, and nothing secret
- objects under `data/` with meaningless names
- how many there are, roughly how large they are, and when they were uploaded

The folder structure is gone too. A whole path is encrypted into a single name, so everything under `data/` is flat.

| What           | How                                                                                                                                                                    |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Key derivation | scrypt (N=131072, r=8, p=1). The password and the salt yield three keys: one for contents, one for names, one for the name MAC                                         |
| Contents       | AES-256-GCM with a random nonce per upload. The modification time is encrypted along with the data; the format version and object name are bound in as associated data |
| Paths          | AES-256-GCM with a nonce derived from the HMAC-SHA256 of the path, so a path always maps to the same name                                                              |

Only path encryption is deterministic, because a file has to map to the same object every time. In exchange, a ciphertext moved to another object name fails to decrypt.

If you forget the password, the data in the bucket cannot be decrypted, and there is no recovery mechanism. What you lose is the remote copy, though: the vault on each device is still there in plain form. Sync again to a new prefix with a new password and you are back where you were.

## What the encryption does and does not protect

Someone who can only read the bucket learns counts, sizes and times. What about someone who can write to it, because an API token leaked or because you do not trust the storage operator?

Modification is detected. AES-GCM refuses to decrypt a ciphertext that has been altered. If a single bit differs, the file is reported as a sync error and is never written to the vault. Moving one file's ciphertext into another file's place fails the same way, because each ciphertext is bound to its own object name.

Attacks on `r2v2.json` are closed off as well. If the key-derivation parameters are rewritten to something weak, a range check stops the sync; if the file is replaced with one the attacker prepared, the password check stops it. In both cases nothing has been sent yet.

Some things it cannot prevent:

- **Rollback.** If a file is reverted to an older version that was once written correctly, there is no way to tell. The old version is a genuine ciphertext.
- **Deletion.** A deleted object is indistinguishable from a deletion made by your other device, so the local file is moved to the trash. A large number of them triggers a confirmation dialog.
- **Password guessing.** The check value in `r2v2.json` lets anyone who has it test password guesses offline. scrypt makes each guess cost 128 MiB of memory, but that does not save a short password or a dictionary word. The encryption is exactly as strong as the password.
- **Sizes and timing.** A ciphertext is exactly 41 bytes longer than its plaintext. The size of each file, the length of each path, and when things change are not hidden.
- **The device itself.** The vault sits unencrypted on every device. If a device is compromised, this encryption protects nothing.

The content key is shared by all files, and nonces are 96 random bits. The accepted safe limit for that combination is 2^32 encryptions under one key, about 4.3 billion. Each upload counts as one, which is not a number a personal vault reaches.

All of this is checked in `tests/security.test.ts`: that a separate decryptor (WebCrypto), written from the format description alone, can read the data; that flipping any single bit or truncating at any length is detected; that nonces do not repeat; and that none of the tampering described above reaches the vault.

The encryption has not been audited by a third party. The building blocks (scrypt, AES-256-GCM, HMAC-SHA256) are the standard Node.js implementations, but the way they are combined is specific to R2V2.

## Network use and accounts

R2V2 talks to exactly one place: the R2 endpoint of the account you configure (`https://<account-id>.r2.cloudflarestorage.com`, or the endpoint URL you enter). It lists, uploads, downloads and deletes encrypted files there, and does nothing else. There is no server run by the author, and nowhere that analytics or telemetry could go.

You need your own Cloudflare account and an R2 bucket. R2 has a free tier, and Cloudflare bills for usage beyond it. The plugin itself is free and MIT licensed.

It reads and writes only inside the vault, and never touches files outside it.

## Setup

1. In the Cloudflare dashboard, create an R2 bucket and an API token with "Object Read & Write" permission for that bucket. Note the access key ID and the secret access key.
2. Download `main.js` and `manifest.json` from [Releases](https://github.com/dyoshimitsu/R2V2/releases) into `.obsidian/plugins/artoo-veetoo/` in your vault. To build it yourself:

   ```sh
   npm install
   npm run build
   mkdir -p /path/to/vault/.obsidian/plugins/artoo-veetoo
   cp main.js manifest.json /path/to/vault/.obsidian/plugins/artoo-veetoo/
   ```

   With fish, `scripts/install.fish /path/to/vault` does the build and the copy in one step.

3. Enable R2V2 under Community plugins, then enter the account ID, access key ID and bucket name in its settings. For the secret access key and the encryption password, create a new Obsidian secret in each field and select it. "Test connection" checks the result.
4. Run the first sync from the sync icon in the ribbon, or with the command "R2V2: Sync now".
5. Repeat steps 2 to 4 on the other device, with the same password and prefix.

If the second device has a different password from the first, the sync stops without touching anything. `r2v2.json` holds an encrypted constant, and the password is checked by whether it decrypts.

It is fine if the second device already has a copy of the same vault. The first sync deletes nothing and reconciles the two sides: files with identical contents are adopted as they are, and only the ones that differ are treated as conflicts.

## Telling a deletion from a new file

A file exists locally and not on the remote. Was it deleted on the other device, or has it simply not been uploaded yet? Comparing the two sides cannot tell.

Each device keeps a record of how things stood when its last sync finished: the local modification time and size, and the remote ETag. Comparing the local state, the remote state and that record shows which side moved.

| Local     | Remote    | Action                            |
| --------- | --------- | --------------------------------- |
| changed   | unchanged | upload                            |
| unchanged | changed   | download                          |
| deleted   | unchanged | delete on the remote              |
| unchanged | deleted   | move the local file to the trash  |
| changed   | deleted   | upload (an edit beats a deletion) |
| deleted   | changed   | download (likewise)               |
| changed   | changed   | conflict                          |

The record lives in `.obsidian/plugins/artoo-veetoo/sync-state.json` and is never synced. If the bucket, the prefix or the salt changes, the record is discarded and the next sync is treated as a first sync.

By default a conflict keeps both versions. The remote version takes the original path, and the local one is renamed to something like `Note (conflict 20261111-134500).md`, which reaches the other device on the next sync. You can choose "Keep the more recently modified version" instead.

In case the other device uploads the same file while a sync is in progress, uploads use conditional writes (`If-Match` / `If-None-Match`). An upload that loses the race is withdrawn and handled as a conflict on the next sync.

### Large changes

A correct three-way comparison still produces a wrong result from wrong input, such as pointing a different vault at the same prefix.

When a single sync would overwrite or delete more than a set share of the synced files (50% by default), a confirmation dialog appears first. Cancelling changes nothing. Files deleted locally go to the trash, following Obsidian's "Deleted files" setting.

## Settings

| Setting                | Default    | Notes                                                                                                  |
| ---------------------- | ---------- | ------------------------------------------------------------------------------------------------------ |
| Account ID             | —          | Your Cloudflare account ID. A full endpoint URL also works (for EU-jurisdiction buckets, for example)  |
| Prefix                 | empty      | Location inside the bucket. Use it to keep several vaults in one bucket                                |
| Encryption password    | —          | Required. Stored as a secret. Use the same value on every device                                       |
| Sync on startup        | on         | Once, a few seconds after startup                                                                      |
| Sync interval          | 5 minutes  | 0 disables                                                                                             |
| Sync after editing     | 30 seconds | Syncs once this long has passed since the last edit. 0 disables                                        |
| On conflict            | keep both  | Or keep the more recently modified version                                                             |
| Confirm large changes  | 50%        | Asks before overwriting or deleting more than this share                                               |
| Sync the config folder | off        | Syncs `.obsidian`. `workspace.json` and this plugin's own folder are always excluded                   |
| Paths to ignore        | empty      | One glob per line. `*` matches within a folder, `**` across folders. A folder name covers its contents |
| File size limit        | 100 MB     | Larger files are not synced. 0 means no limit                                                          |
| Concurrent transfers   | 4          |                                                                                                        |

## Limitations

- The secret access key and the encryption password are kept in Obsidian's secret storage. They are not written into the vault folder, so they do not travel with the vault if you put it in Git or sync it some other way; `data.json` holds only the names of the secrets. That storage is Obsidian's local storage on the device, though, and does not protect against someone who gets into the device.
- Each file is read into memory whole and encrypted in one piece. It is not suited to very large files.
- A rename is seen as a deletion plus a new file. Empty folders are not synced.
- Changing the password is not supported. To change it, sync again to a new prefix.
- Files and folders whose names start with a dot are not synced, apart from the config folder.
- There is no one-way sync mode.

## Development

```sh
npm run dev       # watch build
npm run build     # production build
npm run check     # type check, format check, unit tests
npm run test:s3   # integration tests (needs Docker)
npm run format    # format with Prettier
```

| File                                                     | Role                                                                      |
| -------------------------------------------------------- | ------------------------------------------------------------------------- |
| `src/sync.ts`                                            | The sync engine: plans with a three-way comparison, then executes         |
| `src/cipher.ts`                                          | The encryption format (key derivation, contents, paths)                   |
| `src/encrypted-remote.ts`                                | The remote behind encryption; sets up `r2v2.json` and checks the password |
| `src/s3.ts`, `src/sigv4.ts`, `src/s3xml.ts`              | Client for R2's S3 API, request signing, response parsing                 |
| `src/localfs.ts`                                         | Reading and writing the vault                                             |
| `src/main.ts`, `src/settings.ts`, `src/confirm-modal.ts` | The plugin itself and its interface                                       |
| `src/i18n.ts`                                            | Interface text in English and Japanese                                    |

The sync engine and the encryption layer do not depend on Obsidian. The tests reproduce two devices with an in-memory bucket and in-memory vaults.

### Testing against a real server

There is no emulator for R2's S3 API. Cloudflare's Miniflare emulates the binding used from Workers, not the S3 API this plugin uses.

The integration tests therefore run against [SeaweedFS](https://github.com/seaweedfs/seaweedfs), an S3-compatible server. It verifies request signatures and supports conditional writes, so signing, key encoding, pagination and lost upload races are all exercised over real HTTP. `npm run test:s3` starts the server in Docker, runs the tests and cleans up.

SeaweedFS is still not R2. The same tests can be pointed at R2 itself:

```sh
R2V2_TEST_ENDPOINT=<account ID> \
R2V2_TEST_BUCKET=<test bucket> \
R2V2_TEST_ACCESS_KEY_ID=<access key ID> \
R2V2_TEST_SECRET_ACCESS_KEY=<secret> \
npm run test:integration
```

With [direnv](https://direnv.net/), copy `.envrc.example` to `.envrc` and fill in the values. `.envrc` is ignored by Git.

The tests write only under a random prefix and remove what they wrote. Even so, use a bucket other than the one that holds your vault.

### CI

On every push to `master` and every pull request, GitHub Actions runs:

- the type check, format check, unit tests and build, on Ubuntu and macOS. The built `main.js` and `manifest.json` can be downloaded from the run page as the `artoo-veetoo` artifact
- the integration tests against SeaweedFS
- the integration tests against R2, only when the repository variable `R2V2_TEST_BUCKET` and the secrets `R2V2_TEST_ACCOUNT_ID`, `R2V2_TEST_ACCESS_KEY_ID` and `R2V2_TEST_SECRET_ACCESS_KEY` are set

### Releasing

```sh
npm version 0.2.0        # also updates manifest.json and versions.json, commits, and tags 0.2.0
git push --follow-tags
```

The tag has no `v` prefix and is the same string as `version` in `manifest.json`, because Obsidian downloads `main.js` and `manifest.json` from the GitHub release with that tag. When the tag is pushed, GitHub Actions runs the checks, builds, attaches a provenance attestation to the artifacts and creates the release as a draft. Write the release notes and publish it.

## Prior art

The design draws on [BYOC (Bring Your Own Cloud)](https://community.obsidian.md/plugins/byoc). Three-way sync, conflict copies, protection by share of changes, config-folder sync, ignore paths and the size limit follow the approach of BYOC and of [Remotely Save](https://github.com/remotely-save/remotely-save), which it is based on.

BYOC supports twelve storage services and makes encryption optional. R2V2 narrows the target to R2 and makes encryption mandatory. Its encryption format is its own and is not compatible with BYOC's rclone crypt format. No code is shared.

## License

MIT
