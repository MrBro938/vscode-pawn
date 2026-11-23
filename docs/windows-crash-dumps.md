# Collecting Windows crash dumps

Pawn Tools writes JavaScript diagnostics and periodic runtime checkpoints to its VS Code global storage. These files can show the last known process memory, V8 heap usage, active resources, language-server state and recent activity.

A forced termination, native Electron/Node.js crash or operating-system kill may happen before JavaScript can write an error or run its exit handlers. In that case, use Windows Error Reporting (WER) to collect a process dump.

## Enable per-process dumps for VS Code

WER LocalDumps is disabled by default and configuring it requires administrator privileges. Start with a **minidump**; it is smaller than a full dump and may be enough to identify the faulting module and native stack.

1. Open PowerShell **as Administrator**.
2. Run:

```powershell
$dumpFolder = Join-Path $env:LOCALAPPDATA "CrashDumps"
New-Item -ItemType Directory -Force -Path $dumpFolder | Out-Null

$key = "HKLM:\SOFTWARE\Microsoft\Windows\Windows Error Reporting\LocalDumps\Code.exe"
New-Item -Path $key -Force | Out-Null

New-ItemProperty -Path $key -Name DumpFolder -PropertyType ExpandString -Value "%LOCALAPPDATA%\CrashDumps" -Force | Out-Null
New-ItemProperty -Path $key -Name DumpCount -PropertyType DWord -Value 3 -Force | Out-Null
New-ItemProperty -Path $key -Name DumpType -PropertyType DWord -Value 1 -Force | Out-Null
```

3. Restart VS Code and reproduce the crash.
4. Check `%LOCALAPPDATA%\CrashDumps` for newly created `.dmp` files.

The per-application key targets `Code.exe`, so it may collect dumps for any VS Code process that crashes, not only the Pawn extension host. WER only creates a dump for a qualifying application crash; it does not guarantee a dump for every forced termination or resource-exhaustion event.

### Full dumps (only when needed)

A full dump can contain source code, open documents, tokens and other sensitive process memory. It can also be very large. Only switch to it when a minidump does not contain enough information:

```powershell
New-ItemProperty -Path $key -Name DumpType -PropertyType DWord -Value 2 -Force | Out-Null
```

After capturing the required dump, disable the per-application collection:

```powershell
Remove-Item -Path $key -Recurse -Force
```

## Check Windows Event Viewer

After a crash, open **Event Viewer → Windows Logs → Application** and inspect events at the exact crash time. Look for **Application Error** (often Event ID 1000) and **Windows Error Reporting** (often Event ID 1001). The useful fields are:

- Faulting application name and path.
- Faulting module name and path.
- Exception code.
- Fault offset and process ID.

A process dump and the corresponding Event Viewer entry are more useful together than either one alone.
