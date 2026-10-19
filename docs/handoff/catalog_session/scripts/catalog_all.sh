S="C:/Users/USER/AppData/Local/Temp/claude/d--Fomcraft-FMC-BIM-27-FMC-PLUGINS-FMC-REVIT-TOOLS/e0b17a38-1beb-4501-9340-fc53942749d5/scratchpad"
K="D:/Fomcraft/FMC_BIM_27/FMC_Kit_v2.2/FMC_Kit_v2.2/04_Families/_Staging"
R="$S/catrender/bin/Release/net8.0/catrender.dll"
for f in I/FMC_I_MedEq_Bed_ICU_Electric_Detailed E/FMC_E_LightFixture_OperatingLight_Ceiling_Detailed I/FMC_I_MedEq_Machine_Anaesthesia_Detailed I/FMC_I_MedEq_Incubator_Neonatal_Detailed A/FMC_A_Door_FlushSingle_Hygienic_Detailed A/FMC_A_Door_LeadLined_Xray_Detailed A/FMC_A_Window_Observation_Internal_Nurse_Detailed A/FMC_A_Window_Hatch_Pharmacy_Dispensing_Detailed A/FMC_A_Window_Laboratory_Fixed_Detailed E/FMC_E_EQ_Generator_Diesel_Standby_Detailed FP/FMC_FP_MechEq_FirePump_Set_Detailed A/FMC_A_Part_LeverRose A/FMC_A_Part_ButtHinge A/FMC_A_Part_OverheadCloser A/FMC_A_Part_PullHandle A/FMC_A_Part_RadiationWarningLight A/FMC_A_Part_BlindKnob A/FMC_A_Part_SpeechGrille; do
  n=$(basename $f); role=$(dirname $f)
  r=$(timeout 600 node "$S/run_code.mjs" "$S/catalog_mesh.cs" "$K/$f.rfa" "$S/meshes/$n.json" 2>&1 | grep -o '"result": "[^"]*' | head -1 | cut -c1-90)
  echo "$n: ${r:-EXPORT FAILED}"
  hang=$(case $n in *Ceiling*) echo --hang;; esac)
  for v in iso back_iso front; do
    sfx=$([ $v = iso ] && echo "" || echo "_$v")
    dotnet "$R" "$S/meshes/$n.json" "$K/$role/_Images/${n}_catalog$sfx.png" $v 1600 1200 $hang > /dev/null || echo "  card $v failed"
    dotnet "$R" "$S/meshes/$n.json" "$K/$role/_Images/${n}_catalog${sfx}_2000.png" $v 2000 1500 $hang > /dev/null || echo "  2000 $v failed"
  done
done
echo ALL DONE
