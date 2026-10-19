[CmdletBinding()]
param(
    [string]$ProjectPath = (Join-Path $HOME "AI-Dev-Projects"),
    [string]$ModelPath = $env:AI_DEV_MODEL_PATH,
    [string]$Image = "ghcr.io/stonebridgeway/ai-dev-system:latest",
    [string]$Clients = "all",
    [switch]$BuildLocal,
    [switch]$SkipSmoke,
    [switch]$AllowStaleImage,
    [switch]$SkipClientInstall,
    [switch]$Plan
)

# The Docker path on Windows: check Docker, pull the image, write the AI
# clients' configs. The configs run the image themselves, `docker run -i --rm ...`,
# written by `ai-dev clients install --docker` from this checkout with the Node
# on this machine (22.12+): a Linux container cannot write a config by its
# Windows path. Nothing is compiled here any more: 2.x built a C# proxy on the
# user's machine for Claude (docs/DEFECTS.md, Д-105), and its launchers answered
# the MCP handshake themselves (Д-89).

$ErrorActionPreference = "Stop"
$staleWarning = $null
if ($BuildLocal -and -not $PSBoundParameters.ContainsKey("Image")) {
    $Image = "ai-dev-system:local"
}
$repoRoot = Split-Path -Parent $PSCommandPath
$serverRoot = Join-Path $repoRoot "ai-dev-mcp-server"
$cli = Join-Path $serverRoot "bin\ai-dev.mjs"
$dataVolume = if ($env:AI_DEV_DATA_VOLUME) { $env:AI_DEV_DATA_VOLUME } else { "ai-dev-system-data" }

# Windows PowerShell 5.1 turns what a native command writes to a redirected
# stderr into error records, and with $ErrorActionPreference = "Stop" the first
# of them ends the script — and the image writes its first-run report to stderr
# at every start (docs/DEFECTS.md, Д-320). A native command whose stderr is
# thrown away runs through here, with "Continue"; $LASTEXITCODE says how it did.
function Invoke-Native {
    param([Parameter(Mandatory = $true)][scriptblock]$Command)
    $previous = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try { & $Command } finally { $ErrorActionPreference = $previous }
}

function Get-NodeCommand {
    $node = Get-Command node.exe -ErrorAction SilentlyContinue
    if (-not $node) { $node = Get-Command node -ErrorAction SilentlyContinue }
    if (-not $node) { return $null }
    return $node.Source
}

function Assert-Node {
    $node = Get-NodeCommand
    if (-not $node) {
        throw "Node.js 22.12 or newer writes the AI clients' configs: install it (winget install OpenJS.NodeJS.LTS), open a new terminal and run bootstrap.ps1 again. Or install AI Dev with its Windows installer, which brings its own."
    }
    $version = (& $node --version).Trim()
    $major = [int](($version -replace '^v', '').Split('.')[0])
    $minor = [int](($version -replace '^v', '').Split('.')[1])
    if ($major -lt 22 -or ($major -eq 22 -and $minor -lt 12)) {
        throw "Node.js 22.12 or newer is required; found $version. Update Node.js and run bootstrap.ps1 again."
    }
    return $node
}

function Assert-Docker {
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
        throw "Docker Desktop is required: install it (winget install Docker.DockerDesktop, or https://docs.docker.com/get-docker/), start it, and run bootstrap.ps1 again."
    }
    Invoke-Native { & docker version --format '{{.Server.Version}}' 2>$null }
    if ($LASTEXITCODE -eq 0) { return }
    $desktop = Join-Path $env:ProgramFiles "Docker\Docker\Docker Desktop.exe"
    if (Test-Path -LiteralPath $desktop) {
        Write-Host "Starting Docker Desktop and waiting for the engine..."
        Start-Process -FilePath $desktop -WindowStyle Hidden
        foreach ($attempt in 1..24) {
            Start-Sleep -Seconds 5
            Invoke-Native { & docker version --format '{{.Server.Version}}' 2>$null }
            if ($LASTEXITCODE -eq 0) { return }
        }
    }
    throw "Docker Desktop is not ready. Open Docker Desktop, wait until it reports Running, then run bootstrap.ps1 again."
}

if (-not (Test-Path -LiteralPath $cli)) {
    throw "Run this script from a complete AI Dev clone. Missing: $cli"
}

$resolvedProjectPath = [IO.Path]::GetFullPath($ProjectPath)
$resolvedModelPath = $null
if ($ModelPath) {
    $resolvedModelPath = [IO.Path]::GetFullPath($ModelPath)
}
if ($Plan) {
    # Not $plan: variable names are case-insensitive, and $Plan is the switch
    # this block is answering (docs/DEFECTS.md, Д-70).
    $planDocument = [pscustomobject]@{
        repository = $repoRoot
        project_path = $resolvedProjectPath
        image = $Image
        build_local = [bool]$BuildLocal
        clients = $Clients
        data_volume = $dataVolume
        installs_prerequisites_when_missing = $false
        writes_only_local_client_config = $true
    }
    # Present only when a model folder was given, so the default plan is unchanged.
    if ($resolvedModelPath) {
        $planDocument | Add-Member -NotePropertyName model_path -NotePropertyValue $resolvedModelPath
    }
    $planDocument | ConvertTo-Json -Depth 3
    exit 0
}

if ($resolvedModelPath) {
    if ($resolvedModelPath.Contains(",")) {
        throw "Model path cannot contain a comma when Docker --mount syntax is used."
    }
    if (-not (Test-Path -LiteralPath $resolvedModelPath -PathType Container)) {
        throw "Model path does not exist: $resolvedModelPath"
    }
    # The folder above the model, holding bge-m3-onnx\, mounted read-only as
    # /models (docs/DEFECTS.md Д-69). A folder that holds model files itself is
    # the pre-Д-62 value and would leave the model one level too deep (Д-68).
    foreach ($marker in @("pytorch_model.bin", "modules.json", "config.json", "onnx")) {
        if (Test-Path -LiteralPath (Join-Path $resolvedModelPath $marker)) {
            throw "-ModelPath names the folder above the models, and $resolvedModelPath holds model files itself ($marker). Point it at the parent folder that contains bge-m3-onnx\ (docs/INSTALL.md)."
        }
    }
    if (-not (Test-Path -LiteralPath (Join-Path $resolvedModelPath "bge-m3-onnx"))) {
        Write-Warning "$resolvedModelPath holds no bge-m3-onnx\ yet; dense search will report that it is not set up until a model is put there."
    }
}

Assert-Docker
$node = $null
if ($BuildLocal -or -not $SkipClientInstall) {
    $node = Assert-Node
}

New-Item -ItemType Directory -Path $resolvedProjectPath -Force | Out-Null
if ($BuildLocal) {
    Write-Host "Preparing and auditing the Docker context..."
    & $node (Join-Path $serverRoot "scripts\prepare-docker-context.mjs")
    if ($LASTEXITCODE -ne 0) { throw "Docker context preparation failed (exit code $LASTEXITCODE)." }
    & $node (Join-Path $serverRoot "scripts\audit-docker-context.mjs")
    if ($LASTEXITCODE -ne 0) { throw "Docker context audit failed (exit code $LASTEXITCODE)." }
    Write-Host "Building $Image..."
    & docker build --tag $Image (Join-Path $repoRoot ".docker\build-context")
    if ($LASTEXITCODE -ne 0) { throw "Docker image build failed (exit code $LASTEXITCODE)." }
} else {
    Write-Host "Pulling $Image..."
    & docker pull $Image
    if ($LASTEXITCODE -ne 0) {
        Invoke-Native { & docker image inspect $Image *> $null }
        if ($LASTEXITCODE -ne 0) {
            throw "Could not pull $Image, and no cached copy exists."
        }
        # Installing whatever happened to be in the cache produced bug reports
        # about defects already fixed upstream (docs/DEFECTS.md Д-60), so the age
        # of that copy is stated and using it is a deliberate choice.
        $created = (Invoke-Native { & docker image inspect --format '{{.Created}}' $Image 2>$null } | Select-Object -First 1)
        $digest = (Invoke-Native { & docker image inspect --format '{{index .RepoDigests 0}}' $Image 2>$null } | Select-Object -First 1)
        if ([string]::IsNullOrWhiteSpace($created)) { $created = "unknown" }
        if ([string]::IsNullOrWhiteSpace($digest)) { $digest = "none (image was built locally)" }
        $staleWarning = "Registry pull failed. The cached copy of $Image was created $created (digest: $digest) and is missing anything released since."
        Write-Warning $staleWarning
        if (-not $AllowStaleImage) {
            throw "Stopping rather than installing an image of unknown age. Restore the registry connection and run again, or re-run with -AllowStaleImage to install this copy anyway."
        }
    }
}

if (-not $SkipSmoke) {
    Write-Host "Checking the MCP handshake..."
    # The server's own answer, instructions and all: 2.x checked for a serverInfo
    # a launcher wrote itself (docs/DEFECTS.md Д-89).
    $init = '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"ai-dev-bootstrap","version":"1"}}}'
    $response = Invoke-Native { $init | & docker run --rm -i `
        --read-only `
        --tmpfs /tmp:rw,exec,nosuid,size=512m `
        --network none `
        --security-opt no-new-privileges:true `
        --cap-drop ALL `
        --mount "type=volume,source=$dataVolume,target=/data" `
        $Image 2>$null }
    if ($LASTEXITCODE -ne 0 -or ($response -join "`n") -notmatch '"instructions"') {
        throw "The server in $Image did not answer the MCP handshake."
    }
}

$noClient = $false
if (-not $SkipClientInstall) {
    $installArgs = @("clients", "install", "--docker", "--image=$Image", "--projects=$resolvedProjectPath", "--volume=$dataVolume", "--clients=$Clients")
    if ($resolvedModelPath) { $installArgs += "--model=$resolvedModelPath" }
    # Whether there is a client to write, from the installer's own answer as JSON, not from the words it prints:
    # with none, the hint is this script's -Clients, not the CLI's --clients, and nothing is written (Д-415).
    $planned = & $node $cli @installArgs --dry-run --json
    if ($LASTEXITCODE -ne 0) { throw "Writing the client configs failed (exit code $LASTEXITCODE)." }
    $found = @((($planned -join "`n") | ConvertFrom-Json).clients | Where-Object { $_.status -ne "skipped" })
    if ($found.Count -eq 0) {
        $noClient = $true
        # The ellipsis by its code: Windows PowerShell 5.1 reads a script without a BOM in the ANSI code page.
        Write-Host "No AI client found here (Claude Code, Claude Desktop, Cursor, VS Code, Codex, Gemini CLI). Name one to write its config anyway, -Clients cursor,vscode,$([char]0x2026), or install one and run bootstrap.ps1 again."
    } else {
        Write-Host "Writing the AI clients' configs..."
        & $node $cli @installArgs
        if ($LASTEXITCODE -ne 0) { throw "Writing the client configs failed (exit code $LASTEXITCODE)." }
    }

    # Configs of 2.x name the launcher bootstrap.ps1 copied here: it is brought up
    # to 3.0's, which says it is the 2.x one (owner decision D10). The compiled
    # ClaudeMcpProxy.exe beside it is left as it is: nothing is compiled any more.
    $legacyLauncher = Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::CommonApplicationData)) "AI-Dev-System\run-mcp.ps1"
    if (Test-Path -LiteralPath $legacyLauncher) {
        try {
            Copy-Item -LiteralPath (Join-Path $repoRoot "docker\run-mcp.ps1") -Destination $legacyLauncher -Force
        } catch {
            Write-Warning "Could not update the 2.x launcher at ${legacyLauncher}: $($_.Exception.Message)"
        }
    }
}

# The last line says what was done to the clients, no more, in bootstrap.sh's words (Д-406, Д-415).
if ($SkipClientInstall) {
    Write-Host "AI Dev is ready; the AI clients' configs were left as they were."
} elseif ($noClient) {
    Write-Host "AI Dev is ready; no AI client is connected to it yet."
} else {
    Write-Host "AI Dev is ready. Restart the AI clients to load ai-dev."
}
if ($staleWarning) {
    Write-Warning "Installed from a stale image. $staleWarning"
}
