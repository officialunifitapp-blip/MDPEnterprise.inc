#!/usr/bin/env node
// The manager. Runs before every tool call that can do damage.
// Verdict is binary: "allow" (silent, no prompt) or "ask" (Mario approves).
// Nothing is hard-blocked — the founder always gets the final call.

import { appendFileSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const HOME = process.env.HOME || '/Users/mariodelpietro'
const PROJECT = '/Users/mariodelpietro/agency'
const LOG = `${PROJECT}/.claude/hooks/manager.log`

// Files that ARE the business. Losing one costs real pipeline.
const CANONICAL = [
  'pipeline.md',
  'business-context.md',
  'metrics.md',
  'objections.md',
  'decisions.md',
  'CLAUDE.md',
]

// ---- Bash: things that can hurt the laptop -------------------------------
const LAPTOP = [
  [/\brm\s+(-\w*\s+)*-\w*[rR]\w*[fF]|\brm\s+(-\w*\s+)*-\w*[fF]\w*[rR]/, 'recursive force delete'],
  [/\brm\s+(-\w+\s+)*(\/|~\/|\$HOME)/, 'deleting outside the project'],
  [/\bsudo\b|\bsu\s+-/, 'running as root'],
  [/\b(dd|mkfs|diskutil|fdisk|newfs\w*)\b/, 'raw disk operation'],
  [/\bchmod\s+(-\w+\s+)*777\b|\bchown\b/, 'changing file ownership/permissions'],
  [/\bcurl\b[^|;]*\|\s*(sudo\s+)?(ba)?sh|\bwget\b[^|;]*\|\s*(sudo\s+)?(ba)?sh/, 'piping a download straight into a shell'],
  [/\b(killall|pkill|shutdown|reboot|halt)\b/, 'killing processes or the machine'],
  [/\blaunchctl\s+(unload|remove|bootout|disable)/, 'tearing down a launchd job — this is what runs the 5am engine'],
  [/\b(pmset|defaults\s+write|systemsetup|scutil)\b/, 'changing macOS system settings'],
  [/\b(npm|pnpm|yarn)\s+(install|i|add)\b[^\n]*\s-g\b|\bnpm\s+-g\b/, 'global package install'],
  [/\bbrew\s+(install|uninstall|remove|upgrade|cleanup)\b/, 'changing installed software'],
  [/\bpip3?\s+(install|uninstall)\b/, 'changing python packages'],
  [/>\s*\/dev\/(disk|rdisk)/, 'writing to a raw device'],
  [/\bfind\b[^\n]*-delete\b|\bfind\b[^\n]*-exec\s+rm\b/, 'bulk delete via find'],
  [/\b(security|keychain)\b[^\n]*\b(dump|find-generic-password|find-internet-password|delete)/, 'reading the macOS keychain'],
  [/\.ssh\/|\.aws\/credentials|\.npmrc|id_rsa|id_ed25519/, 'touching credentials'],
  [/\bcrontab\s+(-r|-e)/, 'editing or wiping crontab'],
]

// ---- Bash: things that can hurt the business -----------------------------
const BUSINESS = [
  [/\bgit\s+push\b[^\n]*(--force|-f\b)/, 'force-push — rewrites shared history'],
  [/\bgit\s+reset\s+--hard\b/, 'discarding uncommitted work'],
  [/\bgit\s+clean\b[^\n]*-\w*[dfx]/, 'deleting untracked files'],
  [/\bgit\s+(branch\s+-D|checkout\s+--\s+\.|restore\s+\.)/, 'discarding a branch or local changes'],
  [/\bgit\s+(rebase|filter-branch|reflog\s+expire)\b/, 'rewriting history'],
  [new RegExp(`>\\s*[^\\n>]*(${CANONICAL.join('|')})`), 'truncating a canonical business file'],
  [new RegExp(`\\brm\\b[^\\n]*(${CANONICAL.join('|')})`), 'deleting a canonical business file'],
  [/\brm\b[^\n]*leads?\/|\brm\b[^\n]*\.csv\b/, 'deleting lead data'],
  [/\b(sendmail|mail\s+-s|msmtp|swaks)\b/, 'sending email from the command line'],
  [/\bcurl\b[^\n]*-X\s*(POST|PUT|PATCH|DELETE)/, 'writing to an external service'],
  [/\bgh\s+(pr\s+merge|release|repo\s+delete|secret)/, 'irreversible GitHub action'],
  [/\bvapi\b|\btwilio\b/, 'touching the dialer / phone provider'],
]

function verdictForBash(cmd) {
  for (const [re, why] of LAPTOP) if (re.test(cmd)) return { risk: 'laptop', why }
  for (const [re, why] of BUSINESS) if (re.test(cmd)) return { risk: 'business', why }
  return null
}

function verdictForWrite(tool, input) {
  const p = input.file_path || input.notebook_path || ''
  if (!p) return null
  const abs = resolve(p)
  const inProject = abs.startsWith(PROJECT + '/') || abs === PROJECT
  const inScratch = abs.startsWith('/private/tmp/') || abs.startsWith('/tmp/')

  if (!inProject && !inScratch) {
    if (abs.startsWith(`${HOME}/.claude/`)) return null // agent + settings tuning is normal work
    return { risk: 'laptop', why: `writing outside the agency folder (${abs})` }
  }
  // Write replaces a whole file. On a canonical file that is a data-loss event.
  if (tool === 'Write' && CANONICAL.some((f) => abs.endsWith('/' + f))) {
    return { risk: 'business', why: `overwriting ${abs.split('/').pop()} wholesale — Edit is the safe way to change it` }
  }
  return null
}

function verdictForMcp(tool, input) {
  if (/delete|archive|remove|trash/i.test(tool)) {
    return { risk: 'business', why: `destructive Notion call (${tool})` }
  }
  const blob = JSON.stringify(input || {})
  if (/"archived"\s*:\s*true|"in_trash"\s*:\s*true/.test(blob)) {
    return { risk: 'business', why: 'archiving a Notion record' }
  }
  return null
}

function main() {
  let payload = {}
  try {
    payload = JSON.parse(readFileSync(0, 'utf8') || '{}')
  } catch {
    return emit('ask', 'manager could not read the tool call — approving manually is the safe default')
  }

  const tool = payload.tool_name || ''
  const input = payload.tool_input || {}
  let v = null

  if (tool === 'Bash') v = verdictForBash(String(input.command || ''))
  else if (tool === 'Write' || tool === 'Edit' || tool === 'NotebookEdit') v = verdictForWrite(tool, input)
  else if (tool.startsWith('mcp__')) v = verdictForMcp(tool, input)

  if (!v) return emit('allow', '')
  const scope = v.risk === 'laptop' ? 'LAPTOP' : 'BUSINESS'
  return emit('ask', `${scope} RISK: ${v.why}. Approve only if you meant this.`)
}

function emit(decision, reason) {
  // Only escalations get logged. An allow-everything log is noise, not an audit trail.
  if (decision === 'ask') {
    try {
      appendFileSync(LOG, `${new Date().toISOString()}\t${reason}\n`)
    } catch {}
  }
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: decision,
        permissionDecisionReason: reason,
      },
      suppressOutput: true,
    }),
  )
}

try {
  main()
} catch (e) {
  emit('ask', `manager crashed (${e.message}) — failing closed`)
}
