@echo off
rem Recalculate every cost after changing a price in FMC_Price_Book.csv:
rem   price book -> rates -> discipline packages -> project report and structural report.
rem   scripts\cost\update.cmd "<project 01_WIP>"
setlocal
set REPO=%~dp0..\..
set KIT=D:\Fomcraft\FMC_BIM_27\FMC_Kit_v2.2\FMC_Kit_v2.2\07_Materials
set WIP=%~1
if "%WIP%"=="" set WIP=D:\Fomcraft\FMC_PROJECTS_27\THE OGALA RESIDENCE\01_WIP
for /f %%d in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd"') do set D=%%d
python -I "%REPO%\scripts\cost\rates.py" "%KIT%" || goto :eof
rem web meshes from the latest Revit OBJ exports (fmc_scene_export of the "WEB architecture 3D" / "WEB structure 3D" views)
set MESH=%WIP%\_Report\mesh
set BOXES=Furniture,Lighting Fixtures,Planting,Plumbing Fixtures,Generic Models,Casework,Specialty Equipment,Electrical Fixtures,Furniture Systems,Entourage,Mechanical Equipment
if exist "%MESH%rchitecture.obj" python -I "%REPO%\scripts\project\obj2web.py" "%MESH%rchitecture.obj" "%MESH%rchitecture.web.json" --boundary 0.5 --box "%BOXES%" || goto :eof
if exist "%MESH%\structure.obj" python -I "%REPO%\scripts\project\obj2web.py" "%MESH%\structure.obj" "%MESH%\structure.web.json" || goto :eof
python -I "%REPO%\scripts\project\packages.py" "%WIP%" "%WIP%\_Report" || goto :eof
python -I "%REPO%\scripts\project\report.py" "%WIP%\_Report" "%WIP%\_Report\%D%_project_report.html" || goto :eof
for /f "delims=" %%f in ('dir /b /o-n "%WIP%\_Structure\*_rc_design.json"') do (set DJ=%%f& goto :have)
:have
python "%REPO%\scripts\structure\report_visual.py" "%WIP%\_Structure\_work" "%WIP%\_Structure\Robot" "%WIP%\_Structure\%DJ%" "%WIP%\_Structure\img" "%WIP%\_Structure\%D%_structural_design_report_visual.html"
echo Costs updated from the price book.
