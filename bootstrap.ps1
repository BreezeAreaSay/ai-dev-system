[CmdletBinding()]
param(
    [string]$ProjectPath = (Join-Path $HOME "AI-Dev-Projects"),
    [string]$ModelPath = $env:AI_DEV_MODEL_PATH,
    [string]$Image = "ghcr.io/stonebridgeway/ai-dev-system:latest",
    [string]$Clients = "codex,cursor,gemini,vscode,claude",
    [switch]$BuildLocal,
    [switch]$SkipSmoke,
    [switch]$AllowStaleImage,
    [switch]$SkipClientInstall,
    [switch]$Plan
)

$ErrorActionPreference = "Stop"
$staleWarning = $null
if ($BuildLocal -and -not $PSBoundParameters.ContainsKey("Image")) {
    $Image = "ai-dev-system:local"
}
$repoRoot = Split-Path -Parent $PSCommandPath
$serverRoot = Join-Path $repoRoot "ai-dev-mcp-server"
$launcher = Join-Path $repoRoot "docker\run-mcp.ps1"

function Test-Administrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Install-Prerequisite([string]$DisplayName, [string]$WingetId) {
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
        throw "$DisplayName is missing and winget is unavailable. Install $DisplayName manually, then run this script again."
    }
    if (-not (Test-Administrator)) {
        throw "$DisplayName is missing. Run bootstrap.ps1 from an elevated PowerShell once so winget can install it."
    }
    Write-Host "Installing $DisplayName through winget..."
    & winget install --exact --id $WingetId --silent --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -ne 0) {
        throw "winget could not install $DisplayName (exit code $LASTEXITCODE). Complete the installation, open a new terminal, and run this script again."
    }
}

function Get-NodeCommand {
    $node = Get-Command node.exe -ErrorAction SilentlyContinue
    if (-not $node) { $node = Get-Command node -ErrorAction SilentlyContinue }
    if (-not $node) { return $null }
    return $node.Source
}

function Ensure-Node {
    $node = Get-NodeCommand
    if (-not $node) {
        Install-Prerequisite "Node.js LTS" "OpenJS.NodeJS.LTS"
        $nodeBin = Join-Path $env:ProgramFiles "nodejs"
        if (Test-Path -LiteralPath $nodeBin) { $env:PATH = "$nodeBin;$env:PATH" }
        $node = Get-NodeCommand
    }
    if (-not $node) {
        throw "Node.js was installed but is not available in this terminal. Open a new PowerShell window and run bootstrap.ps1 again."
    }
    $version = (& $node --version).Trim()
    $major = [int](($version -replace '^v', '').Split('.')[0])
    $minor = [int](($version -replace '^v', '').Split('.')[1])
    if ($major -lt 22 -or ($major -eq 22 -and $minor -lt 12)) {
        throw "Node.js 22.12 or newer is required; found $version. Update Node.js and run bootstrap.ps1 again."
    }
    return $node
}

function Ensure-Docker {
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
        Install-Prerequisite "Docker Desktop" "Docker.DockerDesktop"
    }
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
        throw "Docker Desktop was installed but docker is not available in this terminal. Open a new PowerShell window, start Docker Desktop, and run bootstrap.ps1 again."
    }
    & docker version --format '{{.Server.Version}}' 2>$null
    if ($LASTEXITCODE -eq 0) { return }

    $desktop = Join-Path $env:ProgramFiles "Docker\Docker\Docker Desktop.exe"
    if (Test-Path -LiteralPath $desktop) {
        Write-Host "Starting Docker Desktop and waiting for the engine..."
        Start-Process -FilePath $desktop -WindowStyle Hidden
        foreach ($attempt in 1..24) {
            Start-Sleep -Seconds 5
            & docker version --format '{{.Server.Version}}' 2>$null
            if ($LASTEXITCODE -eq 0) { return }
        }
    }
    throw "Docker Desktop is not ready. Open Docker Desktop, wait until it reports Running, then run bootstrap.ps1 again."
}

function Get-NpmCommand([string]$NodePath) {
    $candidate = Join-Path (Split-Path -Parent $NodePath) "npm.cmd"
    if (Test-Path -LiteralPath $candidate) { return $candidate }
    $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if (-not $npm) { $npm = Get-Command npm -ErrorAction SilentlyContinue }
    if (-not $npm) { throw "npm is missing next to Node.js. Repair the Node.js installation and run bootstrap.ps1 again." }
    return $npm.Source
}

function Install-ClientLauncher([string]$SourceLauncher, [string]$FileName = "run-mcp.ps1") {
    $sharedRoot = [Environment]::GetFolderPath([Environment+SpecialFolder]::CommonApplicationData)
    $targetRoot = Join-Path $sharedRoot "AI-Dev-System"
    $target = Join-Path $targetRoot $FileName
    try {
        New-Item -ItemType Directory -Path $targetRoot -Force | Out-Null
        Copy-Item -LiteralPath $SourceLauncher -Destination $target -Force
        return $target
    } catch {
        throw "Could not install the ASCII-path MCP launcher at $target. Run bootstrap.ps1 from an elevated PowerShell, then try again. $($_.Exception.Message)"
    }
}

function Install-ClaudeMcpProxy {
    $sharedRoot = [Environment]::GetFolderPath([Environment+SpecialFolder]::CommonApplicationData)
    $targetRoot = Join-Path $sharedRoot "AI-Dev-System"
    $source = Join-Path $repoRoot "docker\ClaudeMcpProxy.cs"
    $stagedSource = Join-Path $targetRoot "ClaudeMcpProxy.cs"
    $target = Join-Path $targetRoot "ClaudeMcpProxy.exe"
    $compiler = Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"
    if (-not (Test-Path -LiteralPath $compiler)) {
        throw "Windows .NET Framework compiler is unavailable: $compiler"
    }
    try {
        New-Item -ItemType Directory -Path $targetRoot -Force | Out-Null
        Copy-Item -LiteralPath $source -Destination $stagedSource -Force
        & $compiler /nologo /target:exe "/out:$target" $stagedSource
        if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $target)) {
            throw "C# compiler exited with code $LASTEXITCODE."
        }
        return $target
    } catch {
        throw "Could not install the Claude fast-start MCP proxy. $($_.Exception.Message)"
    }
}

if (-not (Test-Path -LiteralPath (Join-Path $serverRoot "package.json"))) {
    throw "Run this script from a complete AI Dev MCP System clone. Missing: $serverRoot\package.json"
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
        installs_prerequisites_when_missing = $true
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
    # The folder above the models, holding bge-m3-onnx\ and/or bge-m3; the
    # launcher mounts it read-only as /models (docs/DEFECTS.md Д-69). A folder
    # that holds model files itself is the pre-Д-62 value of the variable and
    # would leave both backends looking one level too deep (Д-68).
    foreach ($marker in @("pytorch_model.bin", "modules.json", "config.json", "onnx")) {
        if (Test-Path -LiteralPath (Join-Path $resolvedModelPath $marker)) {
            throw "-ModelPath names the folder above the models, and $resolvedModelPath holds model files itself ($marker). Point it at the parent folder that contains bge-m3-onnx\ and/or bge-m3\ - for a default install that is $HOME\.ai-dev\models (docs/INSTALL.md)."
        }
    }
    if (-not (Test-Path -LiteralPath (Join-Path $resolvedModelPath "bge-m3-onnx")) -and -not (Test-Path -LiteralPath (Join-Path $resolvedModelPath "bge-m3"))) {
        Write-Warning "$resolvedModelPath holds neither bge-m3-onnx\ nor bge-m3\ yet; dense search will report that it is not set up until a model is put there."
    }
}

Ensure-Docker
$node = $null
$npm = $null
if ($BuildLocal -or -not $SkipClientInstall) {
    $node = Ensure-Node
    $env:PATH = "$(Split-Path -Parent $node);$env:PATH"
}
if ($BuildLocal) {
    $npm = Get-NpmCommand $node
}

New-Item -ItemType Directory -Path $resolvedProjectPath -Force | Out-Null
if ($BuildLocal) {
    Push-Location $serverRoot
    try {
        Write-Host "Installing locked server dependencies..."
        & $npm ci --ignore-scripts --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw "npm ci failed (exit code $LASTEXITCODE)." }

        Write-Host "Preparing and auditing the private-data-safe Docker context..."
        & $npm run docker:prepare
        if ($LASTEXITCODE -ne 0) { throw "Docker context preparation failed (exit code $LASTEXITCODE)." }
        & $npm run docker:audit
        if ($LASTEXITCODE -ne 0) { throw "Docker privacy audit failed (exit code $LASTEXITCODE)." }
    } finally {
        Pop-Location
    }

    Write-Host "Building $Image..."
    & docker build --tag $Image (Join-Path $repoRoot ".docker\build-context")
    if ($LASTEXITCODE -ne 0) { throw "Docker image build failed (exit code $LASTEXITCODE)." }
} else {
    Write-Host "Pulling $Image..."
    & docker pull $Image
    if ($LASTEXITCODE -ne 0) {
        & docker image inspect $Image *> $null
        if ($LASTEXITCODE -ne 0) {
            throw "Could not pull $Image, and no cached copy exists."
        }
        # Installing whatever happened to be in the cache produced bug reports
        # about defects already fixed upstream (docs/DEFECTS.md Д-60), so the age
        # of that copy is stated and using it is now a deliberate choice.
        $created = (& docker image inspect --format '{{.Created}}' $Image 2>$null | Select-Object -First 1)
        # A locally built image has no RepoDigests, and `index` on an empty list
        # fails rather than returning nothing.
        $digest = (& docker image inspect --format '{{index .RepoDigests 0}}' $Image 2>$null | Select-Object -First 1)
        if ([string]::IsNullOrWhiteSpace($created)) { $created = "unknown" }
        if ([string]::IsNullOrWhiteSpace($digest)) { $digest = "none (image was built locally)" }
        $staleWarning = "Registry pull failed. The cached copy of $Image was created $created (digest: $digest) and is missing anything released since."
        Write-Warning $staleWarning
        if (-not $AllowStaleImage) {
            throw "Stopping rather than installing an image of unknown age. Restore the registry connection and run again, or re-run with -AllowStaleImage to install this copy anyway."
        }
        Write-Warning "Continuing because -AllowStaleImage was given. Run 'docker pull $Image' and bootstrap again once the registry is reachable."
    }
}

if (-not $SkipSmoke) {
    Write-Host "Running MCP smoke test..."
    $init = '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"ai-dev-bootstrap","version":"1"}}}'
    $response = $init | & docker run --rm -i `
        --read-only `
        --tmpfs /tmp:rw,exec,nosuid,size=512m `
        --tmpfs /data:rw,nosuid,size=512m,uid=1000,gid=1000,mode=0700 `
        --shm-size 1g `
        --network none `
        --security-opt no-new-privileges:true `
        --cap-drop ALL `
        $Image
    if ($LASTEXITCODE -ne 0 -or ($response -join "`n") -notmatch '"serverInfo"') {
        throw "Docker MCP smoke test failed."
    }
}

$modelPathArgs = @()
if ($resolvedModelPath) {
    $modelPathArgs = @("--model-path", $resolvedModelPath)
}
if (-not $SkipClientInstall) {
    Write-Host "Installing local MCP client configurations..."
    $clientLauncher = Install-ClientLauncher $launcher
    $claudeLauncher = Install-ClaudeMcpProxy
    $env:AI_DEV_INSTALLER_LAUNCHER = $clientLauncher
    & $node (Join-Path $serverRoot "scripts\install-docker-mcp-clients.mjs") `
        --apply `
        --launcher-env AI_DEV_INSTALLER_LAUNCHER `
        --claude-launcher $claudeLauncher `
        --image $Image `
        --project-path $resolvedProjectPath `
        @modelPathArgs `
        --clients $Clients
    if ($LASTEXITCODE -ne 0) { throw "MCP client configuration failed (exit code $LASTEXITCODE)." }
}

Write-Host "AI Dev MCP System is ready. Restart the selected AI clients to load the ai-dev MCP server."
if ($resolvedModelPath) {
    Write-Host "Model weights will be mounted read-only from $resolvedModelPath as /models by the launcher."
}
if ($staleWarning) {
    Write-Warning "Installed from a stale image. $staleWarning"
}
