@echo off
"%~dp0containment-probe.exe" self > "%~dp0env3-self.json" 2>&1
"%~dp0containment-probe.exe" tree --shape startb --budget-ms 2000 > "%~dp0env3-startb.json" 2>&1
