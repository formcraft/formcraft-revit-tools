// KISIC step 09 – lab casework (fmc_casework run as DirectShape massing), lab fridge, X-ray + ultrasound placeholders, control console. transactionMode "none", parameters ["dry"|"real"].
// Replace with real families when: FMC_A_Casework_LabBench recipe exists (kit), and the X-ray/ultrasound makers are known.
bool dry=(string)parameters[0]=="dry"; var log=new StringBuilder();
Func<double,double,double,XYZ> P=(x,y,z)=>FmcScript.PointMm(x*1000,-y*1000,z);
using(var t=new Transaction(document,"KISIC lab casework + X-ray placeholder")){ var fo=t.GetFailureHandlingOptions(); fo.SetFailuresPreprocessor(new FmcFailures()); t.SetFailureHandlingOptions(fo); t.Start();
try{
 Material M(string n,Color c){ var m=new FilteredElementCollector(document).OfClass(typeof(Material)).Cast<Material>().FirstOrDefault(x=>x.Name==n); if(m==null){ m=(Material)document.GetElement(Material.Create(document,n)); m.Color=c; } return m; }
 var mel=M("FMC_Board_Melamine_White",new Color(240,240,236)); var qz=M("FMC_Stone_Quartz_Engineered_White",new Color(236,234,228)); var tile=M("FMC_Tile_Ceramic_Wall_300x600",new Color(250,250,250)); var grey=M("FMC_Plastic_ABS_MedicalGrey",new Color(180,184,188)); var steel=M("FMC_Metal_Steel_EpoxyCoated_White",new Color(235,235,235)); var plinth=M("FMC_Plastic_ABS_Grey",new Color(120,120,120));
 Solid Box(double x0,double y0,double x1,double y1,double z0,double z1,Material m){ var cl=new CurveLoop(); var a=P(x0,y0,z0); var b=P(x1,y0,z0); var c=P(x1,y1,z0); var d=P(x0,y1,z0); cl.Append(Line.CreateBound(a,b)); cl.Append(Line.CreateBound(b,c)); cl.Append(Line.CreateBound(c,d)); cl.Append(Line.CreateBound(d,a));
  return GeometryCreationUtilities.CreateExtrusionGeometry(new List<CurveLoop>{cl},XYZ.BasisZ,FmcScript.Mm(z1-z0),new SolidOptions(m.Id,ElementId.InvalidElementId)); }
 DirectShape DS(BuiltInCategory cat,string name,List<GeometryObject> g,string mark){ var ds=DirectShape.CreateElement(document,new ElementId(cat)); ds.SetShape(g); ds.Name=name; ds.get_Parameter(BuiltInParameter.ALL_MODEL_MARK)?.Set(mark); ds.get_Parameter(BuiltInParameter.ALL_MODEL_INSTANCE_COMMENTS)?.Set(name); return ds; }
 var g=new List<GeometryObject>();
 foreach(var u in new[]{new[]{3.65,4.65},new[]{4.65,5.55},new[]{5.60,6.20},new[]{6.20,6.68}}){ g.Add(Box(0.04,u[0]+0.002,0.56,u[1]-0.002,100,870,mel)); }
 g.Add(Box(0.00,3.65,0.50,6.68,0,100,plinth)); g.Add(Box(0.00,3.65,0.60,6.68,870,900,qz));
 foreach(var u in new[]{new[]{0.60,1.60},new[]{1.60,2.15}}){ g.Add(Box(u[0]+0.002,3.65,u[1]-0.002,4.21,100,870,mel)); }
 g.Add(Box(0.60,3.65,2.15,4.15,0,100,plinth)); g.Add(Box(0.60,3.65,2.15,4.25,870,900,qz));
 g.Add(Box(0.00,3.65,0.32,6.65,1450,2170,mel)); g.Add(Box(0.32,3.65,2.15,3.97,1450,2170,mel));
 g.Add(Box(0.00,3.65,0.01,6.68,900,1450,tile)); g.Add(Box(0.0,3.65,2.15,3.66,900,1450,tile));
 DS(BuiltInCategory.OST_Casework,"Lab casework LB01-LB07 / LW01-LW05 (fmc_casework run, 11 units)",g,"LAB-CW");
 DS(BuiltInCategory.OST_SpecialityEquipment,"Lab fridge (placeholder)",new List<GeometryObject>{Box(2.17,3.66,2.73,4.26,0,850,steel)},"LAB-FR");
 var xr=new List<GeometryObject>{ Box(0.8,1.35,3.0,2.15,0,650,grey), Box(0.8,1.35,3.0,2.15,650,720,steel), Box(1.2,2.35,1.45,2.6,0,2600,grey), Box(1.3,1.6,1.7,2.4,1800,2000,steel) };
 var dsx=DS(BuiltInCategory.OST_MedicalEquipment,"X-ray unit (placeholder – maker footprint TBC)",xr,"XR-1");
 ElementTransformUtils.RotateElement(document,dsx.Id,Line.CreateBound(P(1.9,1.75,0),P(1.9,1.75,1000)),Math.PI/6);
 DS(BuiltInCategory.OST_MedicalEquipment,"Ultrasound machine (placeholder)",new List<GeometryObject>{Box(5.85,0.25,6.35,0.80,0,850,grey),Box(5.90,0.25,6.30,0.35,850,1450,steel)},"US-1");
 DS(BuiltInCategory.OST_Casework,"Control console shelf 1100 x 500 at 750, HPL",new List<GeometryObject>{Box(4.75,0.20,5.30,1.30,720,750,mel)},"CTL-SH");
 log.Append("lab casework, fridge, X-ray, ultrasound, console");
 if(dry){t.RollBack(); log.Insert(0,"DRY: ");} else log.Insert(0,"BUILT "+t.Commit()+": ");
}catch(Exception ex){ if(t.GetStatus()==TransactionStatus.Started) t.RollBack(); return "FAILED "+ex.GetType().Name+": "+ex.Message+" | "+log; }
}
return log.ToString();
