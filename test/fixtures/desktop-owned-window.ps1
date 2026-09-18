$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type 'using System;using System.Runtime.InteropServices;public static class FixtureWindow {[DllImport("user32.dll")]public static extern bool ShowWindow(IntPtr h,int n);}'
$form=New-Object System.Windows.Forms.Form
$form.Text='ColdX owned computer test'
$form.Size=New-Object System.Drawing.Size(700,550)
$form.StartPosition='CenterScreen'
$form.TopMost=$true
$label=New-Object System.Windows.Forms.Label
$label.Text='Fixture ready'
$label.Location=New-Object System.Drawing.Point(20,20)
$label.AutoSize=$true
$entry=New-Object System.Windows.Forms.TextBox
$entry.AccessibleName='ColdX fixture input'
$entry.Location=New-Object System.Drawing.Point(20,60)
$entry.Size=New-Object System.Drawing.Size(300,30)
$button=New-Object System.Windows.Forms.Button
$button.Text='ColdX fixture button'
$button.Location=New-Object System.Drawing.Point(20,110)
$button.Size=New-Object System.Drawing.Size(200,40)
$button.Add_Click({$label.Text='Clicked';[Console]::WriteLine('{"event":"click"}')})
$entry.Add_TextChanged({[Console]::WriteLine((@{event='text';text=$entry.Text}|ConvertTo-Json -Compress))})
$entry.Add_KeyDown({param($sender,$e);if($e.Control -and $e.KeyCode -eq [System.Windows.Forms.Keys]::A){$entry.SelectAll();$e.SuppressKeyPress=$true};[Console]::WriteLine((@{event='key';key=$e.KeyCode.ToString();control=$e.Control}|ConvertTo-Json -Compress))})
$drag=New-Object System.Windows.Forms.Panel
$drag.AccessibleName='ColdX fixture drag'
$drag.Location=New-Object System.Drawing.Point(20,170)
$drag.Size=New-Object System.Drawing.Size(400,100)
$drag.BackColor=[System.Drawing.Color]::LightBlue
$drag.Add_MouseUp({param($sender,$e);[Console]::WriteLine((@{event='drag';x=$e.X;y=$e.Y}|ConvertTo-Json -Compress))})
$scroll=New-Object System.Windows.Forms.Panel
$scroll.AccessibleName='ColdX fixture scroll'
$scroll.Location=New-Object System.Drawing.Point(20,300)
$scroll.Size=New-Object System.Drawing.Size(600,170)
$scroll.AutoScroll=$true
$scroll.AutoScrollMinSize=New-Object System.Drawing.Size(500,1500)
$scroll.Add_MouseWheel({param($sender,$e);[Console]::WriteLine((@{event='scroll';delta=$e.Delta}|ConvertTo-Json -Compress))})
$form.Controls.AddRange(@($label,$entry,$button,$drag,$scroll))
$form.Add_Shown({[FixtureWindow]::ShowWindow($form.Handle,5)|Out-Null;[Console]::WriteLine((@{event='ready';id=$form.Handle.ToInt64().ToString()}|ConvertTo-Json -Compress))})
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
[System.Windows.Forms.Application]::Run($form)
