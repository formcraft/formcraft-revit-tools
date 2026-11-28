using Newtonsoft.Json;

namespace RevitMCPCommandSet.Models.DataExtraction
{
    /// <summary>
    /// Model for material quantity data
    /// </summary>
    public class MaterialQuantityModel
    {
        [JsonProperty("materialId")]
        public long MaterialId { get; set; }

        [JsonProperty("materialName")]
        public string MaterialName { get; set; }

        [JsonProperty("materialClass")]
        public string MaterialClass { get; set; }

        [JsonProperty("area")]
        public double Area { get; set; } // Square feet

        [JsonProperty("volume")]
        public double Volume { get; set; } // Cubic feet

        /// <summary>Area in square metres (area is Revit's internal square feet).</summary>
        [JsonProperty("areaM2")]
        public double AreaM2 => Math.Round(Area * MaterialUnits.SquareMetresPerSquareFoot, 3);

        /// <summary>Volume in cubic metres (volume is Revit's internal cubic feet).</summary>
        [JsonProperty("volumeM3")]
        public double VolumeM3 => Math.Round(Volume * MaterialUnits.CubicMetresPerCubicFoot, 3);

        [JsonProperty("elementCount")]
        public int ElementCount { get; set; }

        [JsonProperty("elementIds")]
        public List<long> ElementIds { get; set; } = new List<long>();
    }

    /// <summary>
    /// Result container for material quantities
    /// </summary>
    public class GetMaterialQuantitiesResult
    {
        [JsonProperty("totalMaterials")]
        public int TotalMaterials { get; set; }

        [JsonProperty("totalArea")]
        public double TotalArea { get; set; }

        [JsonProperty("totalVolume")]
        public double TotalVolume { get; set; }

        [JsonProperty("totalAreaM2")]
        public double TotalAreaM2 => Math.Round(TotalArea * MaterialUnits.SquareMetresPerSquareFoot, 3);

        [JsonProperty("totalVolumeM3")]
        public double TotalVolumeM3 => Math.Round(TotalVolume * MaterialUnits.CubicMetresPerCubicFoot, 3);

        /// <summary>What the numbers are in: the m² and m³ fields are metric; area, volume, totalArea and totalVolume are Revit's internal feet.</summary>
        [JsonProperty("units")]
        public MaterialUnits Units { get; } = new MaterialUnits();

        [JsonProperty("materials")]
        public List<MaterialQuantityModel> Materials { get; set; } = new List<MaterialQuantityModel>();

        [JsonProperty("success")]
        public bool Success { get; set; }

        [JsonProperty("message")]
        public string Message { get; set; }
    }

    /// <summary>Unit labels and factors for get_material_quantities.</summary>
    public class MaterialUnits
    {
        public const double SquareMetresPerSquareFoot = 0.09290304;
        public const double CubicMetresPerCubicFoot = 0.028316846592;

        [JsonProperty("area")]
        public string Area => "m²";

        [JsonProperty("volume")]
        public string Volume => "m³";

        [JsonProperty("raw")]
        public string Raw => "area, volume, totalArea and totalVolume are Revit's internal units (ft², ft³); use the M2 and M3 fields for metric";
    }
}
