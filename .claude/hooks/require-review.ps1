# Stop hook: if the working tree has code changes that have not been reviewed yet,
# block the stop and tell Claude to run the senior-technical-review subagent first.
#
# Never blocks twice for the same diff, and never blocks when it is already the
# reason Claude is still running (stop_hook_active). Any failure exits silently
# with 0 so a broken hook can never wedge a session.
#
# -DryRun reports what the hook would do without recording the fingerprint, so the
# hook can be exercised by hand without consuming the one block for that diff.

[CmdletBinding()]
param([switch]$DryRun)

$ErrorActionPreference = 'Stop'

try {
    $raw = [Console]::In.ReadToEnd()
    if ($raw) {
        $payload = $raw | ConvertFrom-Json
        if ($payload.stop_hook_active) { exit 0 }
    }

    $repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
    Set-Location $repo

    # .review-state is this hook's own bookkeeping - it must never count as a change.
    $status = @(git status --porcelain | Where-Object { $_ -notmatch '\.claude/\.review-state' }) -join "`n"
    if (-not $status.Trim()) { exit 0 }

    # Fingerprint the change: staged+unstaged diff, plus content hashes of new files.
    $parts = @($status, (@(git diff HEAD) -join "`n"))
    foreach ($f in @(git ls-files --others --exclude-standard | Where-Object { $_ -ne '.claude/.review-state' })) {
        $parts += "$f $(git hash-object -- $f)"
    }
    $fingerprint = $parts -join "`n"

    $sha = [System.BitConverter]::ToString(
        [System.Security.Cryptography.SHA256]::Create().ComputeHash(
            [System.Text.Encoding]::UTF8.GetBytes($fingerprint))).Replace('-', '')

    $stateFile = Join-Path $repo '.claude\.review-state'
    if (Test-Path $stateFile) {
        if ((Get-Content $stateFile -Raw).Trim() -eq $sha) { exit 0 }
    }
    if (-not $DryRun) { Set-Content -Path $stateFile -Value $sha -Encoding utf8 }

    $reason = @'
This session changed code that has not had a senior technical review yet.

Before finishing, launch the `senior-technical-review` subagent with the Agent tool
(subagent_type: "senior-technical-review", run_in_background: false). Tell it what the change
was meant to accomplish; it will read the diff itself.

Then relay its findings to Ian verbatim enough that he can judge them - severity, location,
how each one fails. Do NOT apply any fix, and do not commit, until he approves. If the reviewer
finds nothing, say so in one line.
'@

    @{ decision = 'block'; reason = $reason } | ConvertTo-Json -Compress
    exit 0
}
catch {
    exit 0
}
