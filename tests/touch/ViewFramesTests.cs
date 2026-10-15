using TouchKit.Core.Gestures;
using Xunit;

namespace TouchKit.Core.Tests
{
    /// <summary>Touch follows a view dragged out of Revit's main window into a window of its own.</summary>
    public class ViewFramesTests
    {
        private static readonly FrameWindow Main = new(1, -8, -8, 1928, 1048);

        [Fact]
        public void A_docked_view_belongs_to_the_main_window()
        {
            Assert.Equal(1, ViewFrames.Pick(300, 120, 1600, 1000, new[] { Main }, main: 1));
        }

        [Fact]
        public void A_floating_view_belongs_to_its_own_window_even_over_the_main_window()
        {
            var floating = new FrameWindow(7, 400, 200, 1200, 800);
            Assert.Equal(7, ViewFrames.Pick(408, 232, 1192, 792, new[] { Main, floating }, main: 1));
        }

        [Fact]
        public void A_floating_view_on_a_second_monitor_belongs_to_its_window()
        {
            var floating = new FrameWindow(9, 1920, 0, 3840, 1080);
            Assert.Equal(9, ViewFrames.Pick(1928, 40, 3832, 1072, new[] { Main, floating }, main: 1));
        }

        [Fact]
        public void A_small_palette_over_a_view_is_never_its_frame()
        {
            var palette = new FrameWindow(5, 500, 300, 800, 700); // a floating Properties palette
            Assert.Equal(1, ViewFrames.Pick(300, 120, 1600, 1000, new[] { Main, palette }, main: 1));
        }
    }
}
