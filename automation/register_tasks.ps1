# register_tasks.ps1
$ErrorActionPreference = "Stop"

$workspaceRoot = "C:\Users\Mottram\Documents\nyans-gallery"
$galleryBat = "$workspaceRoot\automation\run-gallery-server.bat"
$syncBat = "$workspaceRoot\automation\run-postiz-status-sync.bat"
$currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name

Write-Host "=== 1. Checking existing tasks ==="
$existingGallery = Get-ScheduledTask -TaskName "Nyans Gallery Server" -ErrorAction SilentlyContinue
$existingSync = Get-ScheduledTask -TaskName "Nyans Postiz Status Sync" -ErrorAction SilentlyContinue

if ($existingGallery) {
    Write-Host "Task 'Nyans Gallery Server' already exists (State: $($existingGallery.State)). Skipping registration."
} else {
    Write-Host "=== 2. Creating 'Nyans Gallery Server' task ==="
    $actionGallery = New-ScheduledTaskAction -Execute $galleryBat -WorkingDirectory $workspaceRoot
    $triggerGallery = New-ScheduledTaskTrigger -AtLogOn -User $currentUser
    $principalGallery = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Limited
    $settingsGallery = New-ScheduledTaskSettingsSet `
        -MultipleInstances IgnoreNew `
        -RestartCount 3 `
        -RestartInterval (New-TimeSpan -Minutes 1) `
        -ExecutionTimeLimit (New-TimeSpan -Seconds 0) `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries `
        -DontStopOnIdleEnd

    Register-ScheduledTask `
        -TaskName "Nyans Gallery Server" `
        -Action $actionGallery `
        -Trigger $triggerGallery `
        -Principal $principalGallery `
        -Settings $settingsGallery `
        -Description "Nyans Gallery Local Server (localhost:4321, Astro Standalone)"

    Write-Host "Registered 'Nyans Gallery Server' successfully."
}

if ($existingSync) {
    Write-Host "Task 'Nyans Postiz Status Sync' already exists (State: $($existingSync.State)). Skipping registration."
} else {
$actionSync = New-ScheduledTaskAction -Execute $syncBat -WorkingDirectory $workspaceRoot
$triggerSync = New-ScheduledTaskTrigger -AtLogOn -User $currentUser
$triggerSync.Delay = 'PT1M'
$triggerSync.Repetition = (New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 15)).Repetition
$triggerSync.Repetition.StopAtDurationEnd = $false

$principalSync = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Limited
$settingsSync = New-ScheduledTaskSettingsSet `
    -MultipleInstances IgnoreNew `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -DontStopOnIdleEnd

Register-ScheduledTask `
    -TaskName "Nyans Postiz Status Sync" `
    -Action $actionSync `
    -Trigger $triggerSync `
    -Principal $principalSync `
    -Settings $settingsSync `
    -Description "Nyans Postiz Status Sync (15min batch, scheduled to published)"

Write-Host "Registered 'Nyans Postiz Status Sync' successfully."
}
