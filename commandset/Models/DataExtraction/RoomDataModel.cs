using Newtonsoft.Json;

namespace RevitMCPCommandSet.Models.DataExtraction
{
    /// <summary>
    /// Model for room data extraction
    /// </summary>
    public class RoomDataModel
    {
        [JsonProperty("id")]
        public long Id { get; set; }

        [JsonProperty("uniqueId")]
        public string UniqueId { get; set; }

        [JsonProperty("name")]
        public string Name { get; set; }

        [JsonProperty("number")]
        public string Number { get; set; }

        [JsonProperty("level")]
        public string Level { get; set; }

        // F-016: metric, with the unit in the name (Revit's own values are feet).
        [JsonProperty("area_m2")]
        public double AreaM2 { get; set; }

        [JsonProperty("volume_m3")]
        public double VolumeM3 { get; set; }

        [JsonProperty("perimeter_mm")]
        public double PerimeterMm { get; set; }

        [JsonProperty("unbounded_height_mm")]
        public double UnboundedHeightMm { get; set; }

        [JsonProperty("department")]
        public string Department { get; set; }

        [JsonProperty("comments")]
        public string Comments { get; set; }

        [JsonProperty("phase")]
        public string Phase { get; set; }

        [JsonProperty("occupancy")]
        public string Occupancy { get; set; }
    }

    /// <summary>
    /// Result container for room data export
    /// </summary>
    public class ExportRoomDataResult
    {
        [JsonProperty("totalRooms")]
        public int TotalRooms { get; set; }

        [JsonProperty("total_area_m2")]
        public double TotalAreaM2 { get; set; }

        [JsonProperty("rooms")]
        public List<RoomDataModel> Rooms { get; set; } = new List<RoomDataModel>();

        [JsonProperty("success")]
        public bool Success { get; set; }

        [JsonProperty("message")]
        public string Message { get; set; }
    }
}
