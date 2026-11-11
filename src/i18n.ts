// User-facing text, in English and Japanese. No Obsidian imports, so the core
// modules and their tests can use it; the plugin picks the language at startup.

const en = {
  status_idle: "Idle",
  status_unconfigured: "Not configured",
  status_syncing: "Syncing…",
  status_progress: "Syncing… {done}/{total}",
  status_error: "Error",
  status_aborted: "Cancelled",
  status_partial: "Partly failed {time}",
  status_synced: "Synced {time}",

  cmd_sync_now: "Sync now",
  ribbon_sync_now: "R2V2: Sync now",

  field_endpoint: "Account ID",
  field_accessKeyId: "Access key ID",
  field_secretAccessKey: "Secret access key",
  field_bucket: "Bucket name",
  field_password: "Encryption password",
  field_prefix: "Prefix",
  desc_endpoint: "Your Cloudflare account ID. A full S3 API endpoint URL also works.",
  desc_accessKeyId: "Access key ID of the R2 API token.",
  desc_secretAccessKey:
    "Secret of the R2 API token. It is stored as an Obsidian secret; choose its name here.",
  desc_bucket: "The bucket to sync with.",
  desc_prefix:
    "Location inside the bucket. Use it to keep several vaults in one bucket. Leave empty for the bucket root.",
  desc_password:
    "Required. File contents, paths and modification times are encrypted with a key derived from this password before upload. It is stored as an Obsidian secret; choose its name here. Use the same value on every device. If you forget it, the remote data cannot be decrypted.",

  test_name: "Test connection",
  test_desc: "Check that R2 can be reached with these credentials and this password.",
  test_button: "Test",
  test_failed: "R2V2: Cannot connect — {message}",
  test_missing: "Not set: {fields}",
  test_ok_uninitialised:
    "R2V2: Connected. The remote is not initialised yet; the first sync will set up encryption.",
  test_ok_no_password: "R2V2: Connected. The encryption password is not set.",
  test_ok: "R2V2: Connected, and the password matches.",

  heading_encryption: "Encryption",
  heading_timing: "When to sync",
  heading_behavior: "Sync behavior",
  heading_maintenance: "Maintenance",

  startup_name: "Sync on startup",
  startup_desc: "Sync once shortly after Obsidian starts.",
  interval_name: "Sync interval (minutes)",
  interval_desc: "0 disables.",
  onsave_name: "Sync after editing (seconds)",
  onsave_desc: "Sync once this many seconds have passed since the last edit. 0 disables.",

  conflict_name: "On conflict",
  conflict_desc: "What to do when the same file was changed on both devices.",
  conflict_keep_both: "Keep both (the local version becomes a conflict copy)",
  conflict_keep_newer: "Keep the more recently modified version",
  protect_name: "Confirm large changes (%)",
  protect_desc: "Ask before a sync that would overwrite or delete more than this share of the synced files.",
  config_name: "Sync the config folder",
  config_desc:
    "Also sync {dir} (plugins, themes, hotkeys and so on). Workspace state and this plugin's own settings are never synced. Reload Obsidian for received settings to take effect.",
  ignore_name: "Paths to ignore",
  ignore_desc:
    "One per line. * matches within a folder, ** across folders. A folder name covers everything under it.",
  maxsize_name: "File size limit (MB)",
  maxsize_desc: "Larger files are not synced. 0 means no limit.",
  concurrency_name: "Concurrent transfers",
  concurrency_desc: "Number of files transferred in parallel.",

  reset_name: "Reset sync state",
  reset_desc:
    "Forget this device's record of the last sync. The next sync is treated as a first sync: nothing is deleted and both sides are reconciled.",
  reset_button: "Reset",
  reset_done: "R2V2: Sync state was reset",

  cancel: "Cancel",
  list_separator: ", ",

  already_syncing: "R2V2: A sync is already running",
  missing_settings: "R2V2: Settings are incomplete — {fields}",
  large_title: "R2V2: Large change detected",
  large_body1:
    "This sync would overwrite or delete {changes} of {total} synced files ({deletions} deletions).",
  large_body2:
    "Cancel if you did not change the sync target or do not expect this. Deleted local files go to the trash.",
  large_confirm: "Sync anyway",
  sync_failed: "R2V2: Sync failed — {message}",
  state_save_failed:
    "R2V2: The sync record could not be saved. Until this is fixed, deletions may be undone and edits may turn into conflicts. See the developer console for details.",
  plugin_dir_missing:
    "R2V2: The plugin's folder is missing, so nothing was synced. Reload Obsidian and enable the plugin again.",
  sync_aborted: "R2V2: Sync cancelled. Nothing was changed.",
  sync_done: "R2V2: Synced ({detail})",
  part_deleted: "deleted {n}",
  part_conflicts: "conflicts {n}",
  part_failed: "failed {n}",
  no_changes: "no changes",
  errors_notice:
    "R2V2: {n} file(s) could not be synced ({key}: {message}). See the developer console for details.",
  conflicts_notice: "R2V2: {n} conflict(s). Your local versions were kept under new names:\n{list}",
  foreign_notice: "R2V2: Ignored {n} object(s) that this password cannot decrypt.",

  err_wrong_password: "Wrong password (the remote is encrypted with a different one)",
  err_meta_unreadable: "{file} cannot be read",
  err_meta_format: "{file} has an unknown format (it may have been written by a newer version)",
  err_no_password: "The encryption password is not set",
  err_remote_missing: "Not found on the remote: {path}",
  err_write_unverified: "Could not verify the file after writing: {path}",
  err_kdf: "Key derivation parameters are out of range (r2v2.json on the remote may have been altered)",
  err_password_empty: "The encryption password is empty",
  err_salt_short: "The salt is too short",
  err_not_r2v2: "Not R2V2-encrypted data",
  err_decrypt: "Decryption failed (the data is corrupted or has been tampered with)",
};

export type TextKey = keyof typeof en;

const ja: Record<TextKey, string> = {
  status_idle: "待機中",
  status_unconfigured: "未設定",
  status_syncing: "同期中…",
  status_progress: "同期中… {done}/{total}",
  status_error: "エラー",
  status_aborted: "中止",
  status_partial: "一部失敗 {time}",
  status_synced: "同期済み {time}",

  cmd_sync_now: "今すぐ同期",
  ribbon_sync_now: "R2V2: 今すぐ同期",

  field_endpoint: "アカウント ID",
  field_accessKeyId: "アクセスキー ID",
  field_secretAccessKey: "シークレットアクセスキー",
  field_bucket: "バケット名",
  field_password: "暗号化パスワード",
  field_prefix: "プレフィックス",
  desc_endpoint: "Cloudflare のアカウント ID。S3 API のエンドポイント URL をそのまま入れてもよい。",
  desc_accessKeyId: "R2 API トークンのアクセスキー ID。",
  desc_secretAccessKey:
    "R2 API トークンのシークレット。Obsidian のシークレットとして保存し、ここではその名前を選ぶ。",
  desc_bucket: "同期先のバケット。",
  desc_prefix: "バケット内の置き場所。複数の vault を 1 つのバケットに置くときに分ける。空ならバケット直下。",
  desc_password:
    "必須。ファイルの内容・パス・更新時刻はこのパスワードから導いた鍵で暗号化してから送る。Obsidian のシークレットとして保存し、ここではその名前を選ぶ。同期する全ての端末で同じ値にする。忘れるとリモートのデータは復号できない。",

  test_name: "接続テスト",
  test_desc: "認証情報とパスワードで R2 に接続できるか確かめる。",
  test_button: "テスト",
  test_failed: "R2V2: 接続できません — {message}",
  test_missing: "未設定: {fields}",
  test_ok_uninitialised: "R2V2: 接続できました。リモートは未初期化で、最初の同期で暗号化の設定が作られます。",
  test_ok_no_password: "R2V2: 接続できました。暗号化パスワードが未設定です。",
  test_ok: "R2V2: 接続できました。パスワードも一致しています。",

  heading_encryption: "暗号化",
  heading_timing: "同期のタイミング",
  heading_behavior: "同期の挙動",
  heading_maintenance: "保守",

  startup_name: "起動時に同期",
  startup_desc: "Obsidian の起動直後に 1 回同期する。",
  interval_name: "定期同期の間隔(分)",
  interval_desc: "0 で無効。",
  onsave_name: "編集後の同期(秒)",
  onsave_desc: "最後の編集からこの秒数だけ静かになったら同期する。0 で無効。",

  conflict_name: "競合したとき",
  conflict_desc: "同じファイルが両方の端末で変更されていた場合の扱い。",
  conflict_keep_both: "両方残す(手元の版を conflict コピーにする)",
  conflict_keep_newer: "更新時刻が新しい方を残す",
  protect_name: "大量変更の確認(%)",
  protect_desc:
    "1 回の同期で、同期済みファイルのうちこの割合を超えて上書き・削除しようとしたら、実行前に確認する。",
  config_name: "設定フォルダも同期",
  config_desc:
    "{dir} (プラグイン、テーマ、ホットキーなど)も同期する。ワークスペースの状態とこのプラグイン自身の設定は対象外。受け取った設定の反映には Obsidian の再読み込みが要る。",
  ignore_name: "同期しないパス",
  ignore_desc:
    "1 行に 1 つ。* はフォルダ内、** はフォルダをまたいで一致する。フォルダを書けば配下すべてが対象。",
  maxsize_name: "ファイルサイズ上限(MB)",
  maxsize_desc: "これより大きいファイルは同期しない。0 で無制限。",
  concurrency_name: "同時転送数",
  concurrency_desc: "並行して転送するファイルの数。",

  reset_name: "同期状態をリセット",
  reset_desc:
    "この端末が覚えている前回同期の記録を捨てる。次回は初回同期として扱われ、何も削除されず、両側のファイルが突き合わされる。",
  reset_button: "リセット",
  reset_done: "R2V2: 同期状態をリセットしました",

  cancel: "中止",
  list_separator: "、",

  already_syncing: "R2V2: 同期中です",
  missing_settings: "R2V2: 設定が足りません — {fields}",
  large_title: "R2V2: 大量の変更を検出しました",
  large_body1:
    "同期済み {total} 件のうち {changes} 件を上書きまたは削除しようとしています(うち削除 {deletions} 件)。",
  large_body2:
    "同期先の設定を変えた覚えがない場合や、心当たりがない場合は中止してください。削除されるローカルのファイルはゴミ箱に移されます。",
  large_confirm: "このまま同期する",
  sync_failed: "R2V2: 同期に失敗しました — {message}",
  state_save_failed:
    "R2V2: 同期の記録を保存できませんでした。直るまでは、削除が元に戻ったり、編集が競合になったりすることがあります。詳細は開発者コンソールにあります。",
  plugin_dir_missing:
    "R2V2: プラグインのフォルダが見つからないため、同期しませんでした。Obsidian を再読み込みして、プラグインを有効にし直してください。",
  sync_aborted: "R2V2: 同期を中止しました。何も変更していません。",
  sync_done: "R2V2: 同期しました({detail})",
  part_deleted: "削除 {n}",
  part_conflicts: "競合 {n}",
  part_failed: "失敗 {n}",
  no_changes: "変更なし",
  errors_notice: "R2V2: {n} 件が同期できませんでした({key}: {message})。詳細は開発者コンソールにあります。",
  conflicts_notice: "R2V2: {n} 件が競合しました。手元の版を別名で残しています:\n{list}",
  foreign_notice: "R2V2: このパスワードで復号できないオブジェクトが {n} 件あり、無視しました。",

  err_wrong_password: "パスワードが違います(リモートは別のパスワードで暗号化されています)",
  err_meta_unreadable: "{file} を読めません",
  err_meta_format: "{file} の形式を解釈できません(より新しい版で作られた可能性があります)",
  err_no_password: "暗号化パスワードが設定されていません",
  err_remote_missing: "リモートにありません: {path}",
  err_write_unverified: "書き込み後に確認できません: {path}",
  err_kdf: "鍵導出パラメータが許容範囲外です(リモートの r2v2.json が書き換えられた可能性があります)",
  err_password_empty: "暗号化パスワードが空です",
  err_salt_short: "ソルトが短すぎます",
  err_not_r2v2: "R2V2 形式の暗号化データではありません",
  err_decrypt: "復号に失敗しました(データが壊れているか、改ざんされています)",
};

const languages: Record<string, Record<TextKey, string>> = { en, ja };
let current: Record<TextKey, string> = en;

/** Choose the language by its code ("ja", "en", "en-GB", …); anything unknown falls back to English. */
export function setLanguage(code: string): void {
  current = languages[code.toLowerCase().split("-")[0]] ?? en;
}

/** Look up a text, filling `{name}` placeholders from `vars`. */
export function t(key: TextKey, vars: Record<string, string | number> = {}): string {
  return current[key].replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in vars ? String(vars[name]) : whole,
  );
}
