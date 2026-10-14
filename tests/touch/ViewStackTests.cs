using TouchKit.Core.Gestures;
using Xunit;

namespace TouchKit.Core.Tests
{
    /// <summary>Background tabs get no touch and no badge: only the front view of a stack of tabs is on screen.</summary>
    public class ViewStackTests
    {
        [Fact]
        public void Tab_behind_the_active_view_is_hidden_even_when_its_rectangle_is_a_little_off()
        {
            var on = ViewStack.OnScreen(new[]
            {
                new StackedView(100, 100, 900, 700, IsActive: true, LastActive: 5),
                new StackedView(102, 98, 900, 703, IsActive: false, LastActive: 3),
            });
            Assert.Equal(new[] { true, false }, on);
        }

        [Fact]
        public void Tiled_views_are_all_on_screen()
        {
            var on = ViewStack.OnScreen(new[]
            {
                new StackedView(0, 0, 500, 700, true, 2),
                new StackedView(500, 0, 1000, 700, false, 1),
            });
            Assert.Equal(new[] { true, true }, on);
        }

        [Fact]
        public void In_another_tab_group_the_most_recently_active_view_is_in_front()
        {
            var on = ViewStack.OnScreen(new[]
            {
                new StackedView(0, 0, 500, 700, true, 9),
                new StackedView(500, 0, 1000, 700, false, 2),
                new StackedView(500, 0, 1000, 700, false, 7),
                new StackedView(500, 0, 1000, 700, false, 0),
            });
            Assert.Equal(new[] { true, false, true, false }, on);
        }

        [Fact]
        public void Views_never_activated_keep_only_the_first_one()
        {
            var on = ViewStack.OnScreen(new[]
            {
                new StackedView(0, 0, 500, 500, false, 0),
                new StackedView(0, 0, 500, 500, false, 0),
            });
            Assert.Equal(new[] { true, false }, on);
        }
    }
}
