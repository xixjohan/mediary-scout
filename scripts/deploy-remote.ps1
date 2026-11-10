[CmdletBinding()]
param(
    [ValidateSet("Dev", "Official")]
    [string]$Mode = "Dev",

    [ValidateSet("Auto", "Direct", "GitArchive", "GitPull")]
    [string]$SyncMethod = "Auto",

    [Alias("FrontendOnly")]
    [switch]$PublicOnly,

    [string]$EnvFile = "env/.envdev",
    [switch]$SkipSmoke,
    [switch]$SkipHealth,
    [switch]$CheckOnly,
    [string]$RemoteExec = ""
)

$ErrorActionPreference = "Stop"

# ANSI 颜色与格式化辅助
function Write-Step([string]$msg) {
    Write-Host "`n====> $msg" -ForegroundColor Cyan
}

function Write-Success([string]$msg) {
    Write-Host " [OK] $msg" -ForegroundColor Green
}

function Write-Warn([string]$msg) {
    Write-Host " [!] $msg" -ForegroundColor Yellow
}

function Write-Fail([string]$msg) {
    Write-Host " [ERR] $msg" -ForegroundColor Red
}

# =============================================================================
# 1. 配置加载适配器 (ConfigAdapter)
# =============================================================================
$resolvedEnvPath = Resolve-Path -Path $EnvFile -ErrorAction SilentlyContinue
if (-not $resolvedEnvPath -or -not (Test-Path $resolvedEnvPath)) {
    throw "Deployment config file not found: $EnvFile. Please ensure env/.envdev exists."
}

Write-Step "Loading deployment config ($Mode mode) from $EnvFile..."

$rawContent = Get-Content $resolvedEnvPath -Raw -Encoding UTF8
$envMap = @{}

$lines = $rawContent -split "`r?`n"
$currentKey = $null
$currentVal = ""
$inMultiLine = $false

foreach ($line in $lines) {
    $trimmed = $line.Trim()
    if (-not $inMultiLine) {
        if ($trimmed.StartsWith("#") -or [string]::IsNullOrWhiteSpace($trimmed)) {
            continue
        }
        if ($line -match '^([A-Za-z0-9_]+)=(.*)$') {
            $currentKey = $matches[1]
            $valPart = $matches[2]
            if ($valPart.StartsWith('"') -and -not ($valPart.EndsWith('"') -and $valPart.Length -gt 1)) {
                $inMultiLine = $true
                $currentVal = $valPart.Substring(1) + "`n"
            } else {
                $valClean = $valPart.Trim('"', "'")
                $envMap[$currentKey] = $valClean
                $currentKey = $null
            }
        }
    } else {
        if ($line.EndsWith('"')) {
            $currentVal += $line.Substring(0, $line.Length - 1)
            $envMap[$currentKey] = $currentVal
            $inMultiLine = $false
            $currentKey = $null
            $currentVal = ""
        } else {
            $currentVal += $line + "`n"
        }
    }
}

# 提取关键通信参数
$deployHost = $envMap["DEPLOY_HOST"]
$deployPort = if ($envMap["DEPLOY_PORT"]) { [int]$envMap["DEPLOY_PORT"] } else { 22 }
$deployUser = if ($envMap["DEPLOY_USER"]) { $envMap["DEPLOY_USER"] } else { "root" }
$sshKeyContent = $envMap["DEPLOY_SSH_KEY"]

if (-not $deployHost) {
    throw "Missing DEPLOY_HOST configuration in $EnvFile"
}

# 提取模式特定参数 (PipelineStrategy & Adapter)
if ($PublicOnly) {
    $Mode = "Dev"
}

if ($Mode -eq "Dev") {
    $targetPort = if ($envMap["DEV_WEB_PORT"]) { $envMap["DEV_WEB_PORT"] } else { "3020" }
    $containerName = if ($envMap["DEV_CONTAINER_NAME"]) { $envMap["DEV_CONTAINER_NAME"] } else { "mediary-dev" }
    $dockerImage = if ($envMap["DEV_DOCKER_IMAGE"]) { $envMap["DEV_DOCKER_IMAGE"] } else { "mediary:dev" }
    $dataVolume = if ($envMap["DEV_DATA_VOLUME"]) { $envMap["DEV_DATA_VOLUME"] } else { "mediary-dev-data" }
    $remoteWorkdir = if ($envMap["DEV_WORKDIR"]) { $envMap["DEV_WORKDIR"] } else { "/opt/mediary-dev" }
    $webBaseUrl = if ($envMap["DEV_WEB_BASE_URL"]) { $envMap["DEV_WEB_BASE_URL"] } else { "http://${deployHost}:${targetPort}/" }
    
    if ($PublicOnly) {
        Write-Success "Adapter [MediaryFastDevAdapter - PublicHotSync] selected: Target ${deployUser}@${deployHost}:${deployPort}, container $containerName"
    } else {
        Write-Success "Adapter [MediaryFastDevAdapter] selected: Target ${deployUser}@${deployHost}:${deployPort}, container $containerName (Port $targetPort), SyncMethod: $SyncMethod"
    }
} else {
    $targetPort = if ($envMap["WEB_PORT"]) { $envMap["WEB_PORT"] } else { "3000" }
    $containerName = if ($envMap["DOCKER_CONTAINER_NAME"]) { $envMap["DOCKER_CONTAINER_NAME"] } else { "mediary" }
    $dockerImage = if ($envMap["DOCKER_IMAGE"]) { $envMap["DOCKER_IMAGE"] } else { "ghcr.io/xixjohan/mediary-scout:latest" }
    $dataVolume = if ($envMap["DOCKER_DATA_VOLUME"]) { $envMap["DOCKER_DATA_VOLUME"] } else { "mediaray-data" }
    $remoteWorkdir = "/opt/mediary-official"
    $webBaseUrl = if ($envMap["WEB_BASE_URL"]) { $envMap["WEB_BASE_URL"] } else { "http://${deployHost}:${targetPort}/" }
    
    Write-Success "Adapter [OfficialReleaseAdapter] selected: Target ${deployUser}@${deployHost}:${deployPort}, container $containerName (Port $targetPort), Image: $dockerImage"
}

# 提取代理与依赖配置
$cleanWebBaseUrl = $webBaseUrl.TrimEnd('/')
$dockerMirror = if ($envMap["DOCKER_MIRROR"]) { $envMap["DOCKER_MIRROR"] } else { "" }
$pansouBaseUrl = if ($envMap["PANSOU_BASE_URL"]) { $envMap["PANSOU_BASE_URL"] } else { "http://${deployHost}:5280" }
$httpProxy = $envMap["HTTP_PROXY"]
$httpsProxy = $envMap["HTTPS_PROXY"]
$noProxy = $envMap["NO_PROXY"]

# =============================================================================
# 2. 安全通信适配器 (TransportAdapter - OpenSSH & ACL Protection)
# =============================================================================
$tempKeyPath = [System.IO.Path]::GetTempFileName()
try {
    if ($sshKeyContent) {
        $cleanKey = $sshKeyContent.Replace("\n", "`n").Trim()
        [System.IO.File]::WriteAllText($tempKeyPath, ($cleanKey + "`n"), [System.Text.Encoding]::ASCII)
        # Windows ACL 防御：严格限定只有当前运行用户具备读取权限，避免 OpenSSH Permissions too open 拒连
        & icacls.exe $tempKeyPath /inheritance:r /grant:r "$($env:USERNAME):(R)" | Out-Null
    }

    function Invoke-RemoteSsh([string]$cmd) {
        $sshArgs = @(
            "-p", "$deployPort",
            "-o", "StrictHostKeyChecking=no",
            "-o", "UserKnownHostsFile=/dev/null",
            "-o", "LogLevel=ERROR"
        )
        if ($sshKeyContent) {
            $sshArgs = @("-i", $tempKeyPath) + $sshArgs
        }
        $sshArgs += @("$deployUser@$deployHost", $cmd)

        $output = & ssh @sshArgs
        if ($LASTEXITCODE -ne 0) {
            throw "SSH command failed (Exit $LASTEXITCODE): $cmd"
        }
        return $output
    }

    # 诊断分支 1: 穿透执行任意远程指令
    if ($RemoteExec) {
        Write-Step "Executing remote command: $RemoteExec"
        $execOutput = Invoke-RemoteSsh $RemoteExec
        Write-Host $execOutput
        return
    }

    # 诊断分支 2: 仅检查主机与容器健康状态
    if ($CheckOnly) {
        Write-Step "Checking remote host connectivity and container status..."
        $uptime = Invoke-RemoteSsh "uptime"
        $disk = Invoke-RemoteSsh "df -h / | tail -1"
        $ps = Invoke-RemoteSsh "docker ps -a --filter name=$containerName"
        Write-Host "Uptime : $uptime"
        Write-Host "Disk   : $disk"
        Write-Host "Docker :`n$ps"
        Write-Success "Host check completed successfully!"
        return
    }

    # =========================================================================
    # 策略分支 A: 静态公共资源秒级热更 (Public HotSync - ~2s)
    # =========================================================================
    if ($PublicOnly) {
        Write-Step "[Dev - Public HotSync] Packaging apps/web/public and streaming to running container..."
        $publicBundle = "public-bundle-$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()).tar.gz"
        $sw = [System.Diagnostics.Stopwatch]::StartNew()
        try {
            if (-not (Test-Path "apps/web/public")) {
                throw "Directory apps/web/public not found."
            }
            & tar.exe -czf $publicBundle -C apps/web/public .
            if ($LASTEXITCODE -ne 0 -or -not (Test-Path $publicBundle)) {
                throw "Failed to create public bundle at $publicBundle"
            }

            # 1. 同步到远程宿主机工作区
            Invoke-RemoteSsh "mkdir -p $remoteWorkdir/apps/web/public"
            $streamArgs = @(
                "-p", "$deployPort",
                "-o", "StrictHostKeyChecking=no",
                "-o", "UserKnownHostsFile=/dev/null",
                "-o", "LogLevel=ERROR"
            )
            if ($sshKeyContent) { $streamArgs = @("-i", $tempKeyPath) + $streamArgs }
            $streamArgs += @("$deployUser@$deployHost", "tar -xzf - -C $remoteWorkdir/apps/web/public")

            $proc = Start-Process -FilePath "ssh" -ArgumentList $streamArgs -RedirectStandardInput $publicBundle -NoNewWindow -Wait -PassThru
            if ($proc.ExitCode -ne 0) {
                throw "Public host sync failed with exit code $($proc.ExitCode)"
            }

            # 2. 如果开发容器正在运行，热补丁打入容器 /app/apps/web/public
            $isRunning = (Invoke-RemoteSsh "docker ps -q --filter name=$containerName").Trim()
            if ($isRunning) {
                $cArgs = @(
                    "-p", "$deployPort",
                    "-o", "StrictHostKeyChecking=no",
                    "-o", "UserKnownHostsFile=/dev/null",
                    "-o", "LogLevel=ERROR"
                )
                if ($sshKeyContent) { $cArgs = @("-i", $tempKeyPath) + $cArgs }
                $cArgs += @("$deployUser@$deployHost", "docker exec -i $containerName tar -xzf - -C /app/apps/web/public")
                $cProc = Start-Process -FilePath "ssh" -ArgumentList $cArgs -RedirectStandardInput $publicBundle -NoNewWindow -Wait -PassThru
                if ($cProc.ExitCode -ne 0) {
                    Write-Warn "Direct container patch exited with code $($cProc.ExitCode)"
                }
            }

            $sw.Stop()
            Write-Success "Public static assets hot-synced in $($sw.ElapsedMilliseconds) ms!"
            Write-Host "Web URL: $webBaseUrl (Press Ctrl+F5 in browser to view changes)" -ForegroundColor Green
            return
        }
        finally {
            if (Test-Path $publicBundle) { Remove-Item $publicBundle -Force -ErrorAction SilentlyContinue }
        }
    }

    # =========================================================================
    # 策略分支 B: 开发部署管线 (Mode: Dev)
    # =========================================================================
    if ($Mode -eq "Dev") {
        # 1/5 确定代码同步策略 (Adaptive Sync Strategy: Auto -> GitArchive (if clean) vs Direct (if dirty))
        $effectiveSync = $SyncMethod
        if ($SyncMethod -eq "Auto") {
            if (Test-Path ".git") {
                $gitStatus = (& git status --porcelain 2>&1)
                if ([string]::IsNullOrWhiteSpace($gitStatus)) {
                    $effectiveSync = "GitArchive"
                    $commitHash = (& git rev-parse --short HEAD 2>&1)
                    Write-Success "Adaptive Strategy: Git tree clean -> selected [GitArchive] ($commitHash) for strict tracking."
                } else {
                    $effectiveSync = "Direct"
                    $dirtyCount = ($gitStatus -split "`r?`n" | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }).Count
                    Write-Warn "Adaptive Strategy: Detected $dirtyCount uncommitted changes -> selected [Direct] to push live workspace."
                }
            } else {
                $effectiveSync = "Direct"
                Write-Success "Adaptive Strategy: Non-git workspace -> selected [Direct]."
            }
        }

        # 执行同步：Direct 实时工作区直推
        if ($effectiveSync -eq "Direct") {
            Write-Step "1/5 [Dev - Direct Sync] Packaging live working tree via native tar (decoupled from Git)..."
            $localBundle = "dev-bundle-$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()).tar.gz"
            try {
                # 排除规则：严格排除跨平台原生二进制、依赖与本地状态，确保 Linux 纯净性
                $tarArgs = @(
                    "-czf", $localBundle,
                    "--exclude=.git",
                    "--exclude=node_modules",
                    "--exclude=.next",
                    "--exclude=apps/web/.next",
                    "--exclude=run",
                    "--exclude=data",
                    "--exclude=env",
                    "--exclude=*.tmp",
                    "--exclude=*.tar.gz",
                    "--exclude=*.log",
                    "package.json", "package-lock.json", "tsconfig.json", "Dockerfile", "Dockerfile.dev", "apps", "packages", "tools", "scripts"
                )
                & tar.exe @tarArgs

                if ($LASTEXITCODE -ne 0 -or -not (Test-Path $localBundle)) {
                    throw "Failed to create direct workspace bundle at $localBundle"
                }

                $bundleSize = [math]::Round((Get-Item $localBundle).Length / 1MB, 2)
                Write-Success "Bundle created ($bundleSize MB). Streaming to ${deployUser}@${deployHost}:${remoteWorkdir}..."

                Invoke-RemoteSsh "mkdir -p $remoteWorkdir"
                $streamArgs = @(
                    "-p", "$deployPort",
                    "-o", "StrictHostKeyChecking=no",
                    "-o", "UserKnownHostsFile=/dev/null",
                    "-o", "LogLevel=ERROR"
                )
                if ($sshKeyContent) { $streamArgs = @("-i", $tempKeyPath) + $streamArgs }
                $streamArgs += @("$deployUser@$deployHost", "tar -xzf - -C $remoteWorkdir")

                $swSync = [System.Diagnostics.Stopwatch]::StartNew()
                $proc = Start-Process -FilePath "ssh" -ArgumentList $streamArgs -RedirectStandardInput $localBundle -NoNewWindow -Wait -PassThru
                $swSync.Stop()

                if ($proc.ExitCode -ne 0) {
                    throw "SSH stream extraction failed with exit code $($proc.ExitCode)"
                }
                Write-Success "Workspace synchronized in $($swSync.ElapsedMilliseconds) ms!"
            }
            finally {
                if (Test-Path $localBundle) { Remove-Item $localBundle -Force -ErrorAction SilentlyContinue }
            }
        }
        # 执行同步：GitArchive 干净提交打包
        elseif ($effectiveSync -eq "GitArchive") {
            Write-Step "1/5 [Dev - GitArchive Sync] Bundling local git HEAD commit..."
            $localBundle = "dev-bundle.tar.gz"
            try {
                if (Test-Path $localBundle) { Remove-Item $localBundle -Force }
                $p = Start-Process -FilePath "git" -ArgumentList "archive", "--output=$localBundle", "HEAD" -NoNewWindow -Wait -PassThru
                if ($p.ExitCode -ne 0 -or -not (Test-Path $localBundle)) {
                    throw "Failed to create git archive bundle at $localBundle"
                }

                Invoke-RemoteSsh "mkdir -p $remoteWorkdir"
                $streamArgs = @(
                    "-p", "$deployPort",
                    "-o", "StrictHostKeyChecking=no",
                    "-o", "UserKnownHostsFile=/dev/null",
                    "-o", "LogLevel=ERROR"
                )
                if ($sshKeyContent) { $streamArgs = @("-i", $tempKeyPath) + $streamArgs }
                $streamArgs += @("$deployUser@$deployHost", "tar -xzf - -C $remoteWorkdir")

                $proc = Start-Process -FilePath "ssh" -ArgumentList $streamArgs -RedirectStandardInput $localBundle -NoNewWindow -Wait -PassThru
                if ($proc.ExitCode -ne 0) {
                    throw "SSH stream extraction failed with exit code $($proc.ExitCode)"
                }
                Write-Success "Git HEAD bundle synchronized to $remoteWorkdir!"
            }
            finally {
                if (Test-Path $localBundle) { Remove-Item $localBundle -Force -ErrorAction SilentlyContinue }
            }
        }
        # 执行同步：GitPull 远程拉取
        elseif ($effectiveSync -eq "GitPull") {
            Write-Step "1/5 [Dev - GitPull Sync] Pulling remote git branch on host..."
            $gitPullCmd = "if [ ! -d '$remoteWorkdir/.git' ]; then mkdir -p '$remoteWorkdir' && git clone https://github.com/xixjohan/mediary-scout.git '$remoteWorkdir'; else git -C '$remoteWorkdir' fetch origin main && git -C '$remoteWorkdir' reset --hard origin/main; fi && git -C '$remoteWorkdir' log -1 --oneline"
            $out = Invoke-RemoteSsh $gitPullCmd
            Write-Host $out -ForegroundColor DarkCyan
            Write-Success "Remote source code synchronized via Git pull!"
        }

        # 2/5 远程 Docker 快速构建
        Write-Step "2/5 [Dev] Building fast development image ($dockerImage) via Dockerfile.dev..."
        $gitSha = (& git rev-parse --short HEAD 2>$null)
        if (-not $gitSha) { $gitSha = "dev-$(Get-Date -Format 'yyyyMMddHHmmss')" }
        # Direct mode: append timestamp so BUILD_COMMIT layer cache busts, new code gets rebuilt
        if ($effectiveSync -eq "Direct") { $gitSha = "$gitSha-dirty-$(Get-Date -Format 'HHmmss')" }

        # 防御 CRLF：清洗工作区内可能的 \r 换行符
        Invoke-RemoteSsh "find $remoteWorkdir/scripts -name '*.sh' -exec sed -i 's/\r$//' {} + 2>/dev/null || true"

        $mirrorArg = if ($dockerMirror) { "--build-arg DOCKER_MIRROR=$dockerMirror" } else { "" }
        $buildProxyArgs = ""
        if ($httpProxy) { $buildProxyArgs += " --build-arg HTTP_PROXY=$httpProxy" }
        if ($httpsProxy) { $buildProxyArgs += " --build-arg HTTPS_PROXY=$httpsProxy" }
        if ($noProxy) { $buildProxyArgs += " --build-arg NO_PROXY=$noProxy" }
        $buildCmd = "docker build $mirrorArg $buildProxyArgs --build-arg GIT_SHA=$gitSha -f $remoteWorkdir/Dockerfile.dev -t $dockerImage $remoteWorkdir"
        Invoke-RemoteSsh $buildCmd
        Write-Success "Development image built successfully!"

        # 3/5 启动开发容器 (独立端口 3010 与独立卷 mediary-dev-data)
        Write-Step "3/5 [Dev] Launching development container ($containerName on port $targetPort)..."

        $proxyFlags = ""
        if ($httpProxy) { $proxyFlags += " -e HTTP_PROXY=$httpProxy" }
        if ($httpsProxy) { $proxyFlags += " -e HTTPS_PROXY=$httpsProxy" }
        if ($noProxy) { $proxyFlags += " -e NO_PROXY=$noProxy" }

        $devRunCmd = "docker rm -f $containerName 2>/dev/null || true; docker run -d --name $containerName --restart unless-stopped --dns 223.5.5.5 --dns 119.29.29.29 -p ${targetPort}:3000 -v ${dataVolume}:/app/data -v ${remoteWorkdir}/apps/web/public:/app/apps/web/public -e TZ=Asia/Shanghai -e NODE_ENV=production -e PORT=3000 -e HOSTNAME=0.0.0.0 -e MEDIA_TRACK_SEARCH_PROVIDER=tmdb -e MEDIA_TRACK_WORKFLOW_ADAPTER=pansou -e MEDIA_TRACK_STORAGE_ADAPTER=115 -e MEDIA_TRACK_AGENT_ADAPTER=vercel-ai -e MEDIA_TRACK_WORKER_MODE=inprocess -e MEDIA_TRACK_SQLITE_PATH=/app/data/mediary.db -e MEDIA_TRACK_DEMO_SEED=0 -e PANSOU_BASE_URL=$pansouBaseUrl -e APP_BASE_URL=$cleanWebBaseUrl $proxyFlags $dockerImage"
        Invoke-RemoteSsh $devRunCmd
        Write-Success "Development container launched (Port $targetPort, Isolated volume $dataVolume)!"

        # 4/5 轮询健康探针 (/api/health)
        if (-not $SkipHealth) {
            Write-Step "4/5 [Dev] Probing container health status..."
            $maxWaitSec = 40
            $waited = 0
            $isHealthy = $false

            while ($waited -lt $maxWaitSec) {
                Start-Sleep -Seconds 2
                $waited += 2

                try {
                    $cState = (Invoke-RemoteSsh "docker inspect --format '{{.State.Status}}' $containerName 2>/dev/null").Trim()
                    if ($cState -eq "exited" -or $cState -eq "dead") {
                        Write-Warn "Container entered $cState state! Recent logs:"
                        Invoke-RemoteSsh "docker logs --tail 30 $containerName"
                        throw "Container terminated unexpectedly (State: $cState)"
                    }

                    $healthCheck = (Invoke-RemoteSsh "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:${targetPort}/api/health 2>/dev/null || true").Trim()
                    if ($healthCheck -eq "200") {
                        $isHealthy = $true
                        break
                    }
                } catch {
                    if ($_.Exception.Message -match "Container terminated") { throw $_ }
                }
            }

            if (-not $isHealthy) {
                Write-Warn "Container did not return 200 on /api/health within $maxWaitSec s. Recent logs:"
                Invoke-RemoteSsh "docker logs --tail 30 $containerName"
            } else {
                Write-Success "Container is healthy and responding with 200 OK!"
            }
        }

        # 5/5 自动化冒烟测试 (Smoke Verification)
        if (-not $SkipSmoke) {
            Write-Step "5/5 [Dev] Executing automated smoke verification..."
            try {
                $commitStamp = (Invoke-RemoteSsh "docker exec $containerName cat /app/BUILD_COMMIT 2>/dev/null").Trim()
                Write-Success "Verified running commit stamp: $commitStamp"

                $smokeResp = (Invoke-RemoteSsh "curl -s http://127.0.0.1:${targetPort}/api/health").Trim()
                Write-Success "Health API payload: $smokeResp"
            } catch {
                Write-Warn "Smoke verification caught warning: $_"
            }
        }

        Write-Step "Fast development deployment finished successfully!"
        Write-Host "Dev Web URL: $webBaseUrl" -ForegroundColor Green
        Write-Host "Notice: Production instance (${deployHost}:3000) remains untouched and fully operational!" -ForegroundColor Cyan
        return
    }

    # =========================================================================
    # 策略分支 C: 官方生产部署管线 (Mode: Official)
    # =========================================================================
    if ($Mode -eq "Official") {
        Write-Step "1/4 [Official] Pulling official release image ($dockerImage)..."
        Invoke-RemoteSsh "docker pull $dockerImage"
        Write-Success "Official image pulled successfully!"

        Write-Step "2/4 [Official] Recreating production container on port $targetPort..."
        $proxyFlags = ""
        if ($httpProxy) { $proxyFlags += " -e HTTP_PROXY=$httpProxy" }
        if ($httpsProxy) { $proxyFlags += " -e HTTPS_PROXY=$httpsProxy" }
        if ($noProxy) { $proxyFlags += " -e NO_PROXY=$noProxy" }

        $prodRunCmd = "docker rm -f $containerName 2>/dev/null || true; docker run -d --name $containerName --restart unless-stopped --dns 223.5.5.5 --dns 119.29.29.29 -p ${targetPort}:3000 -v ${dataVolume}:/app/data -e TZ=Asia/Shanghai -e NODE_ENV=production -e PORT=3000 -e HOSTNAME=0.0.0.0 -e MEDIA_TRACK_SEARCH_PROVIDER=tmdb -e MEDIA_TRACK_WORKFLOW_ADAPTER=pansou -e MEDIA_TRACK_STORAGE_ADAPTER=115 -e MEDIA_TRACK_AGENT_ADAPTER=vercel-ai -e MEDIA_TRACK_WORKER_MODE=inprocess -e MEDIA_TRACK_SQLITE_PATH=/app/data/mediary.db -e MEDIA_TRACK_DEMO_SEED=0 -e PANSOU_BASE_URL=$pansouBaseUrl -e APP_BASE_URL=$cleanWebBaseUrl $proxyFlags $dockerImage"
        Invoke-RemoteSsh $prodRunCmd
        Write-Success "Production container recreated!"

        Write-Step "3/4 [Official] Probing production health..."
        $maxWaitSec = 45
        $waited = 0
        $isHealthy = $false

        while ($waited -lt $maxWaitSec) {
            Start-Sleep -Seconds 2
            $waited += 2
            try {
                $status = (Invoke-RemoteSsh "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:${targetPort}/api/health 2>/dev/null || true").Trim()
                if ($status -eq "200") {
                    $isHealthy = $true
                    break
                }
            } catch {}
        }

        if ($isHealthy) {
            Write-Success "Production container is healthy!"
        } else {
            Write-Warn "Production container failed health check within $maxWaitSec s."
            Invoke-RemoteSsh "docker logs --tail 25 $containerName"
        }

        Write-Step "4/4 [Official] Smoke inspection..."
        $prodCommit = (Invoke-RemoteSsh "docker exec $containerName cat /app/BUILD_COMMIT 2>/dev/null || true").Trim()
        Write-Success "Production image BUILD_COMMIT: $prodCommit"
        Write-Host "Official Web URL: $webBaseUrl" -ForegroundColor Green
    }
}
finally {
    if ($tempKeyPath -and (Test-Path $tempKeyPath)) {
        Remove-Item -Path $tempKeyPath -Force -ErrorAction SilentlyContinue
    }
}
