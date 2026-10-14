using System.Threading.Tasks;
using Formcraft.Shell.Services;
using Formcraft.Shell.ViewModels;

namespace Formcraft.Shell.Tests
{
    /// <summary>F-010: a check no family could run (no kit spec) never shows as Pass.</summary>
    public class FamiliesScanLineTests
    {
        [Test]
        public async Task Nothing_checked_reads_not_checked()
        {
            var l = FamiliesPage.ByCheckLine(("Required FMC parameters present (by GUID)", 0, 0, 346));
            await Assert.That(l.Status).IsEqualTo("Not checked");
            await Assert.That(l.Kind).IsEqualTo(ChipKind.Grey);
        }

        [Test]
        public async Task Some_checked_says_how_many_were_not()
        {
            var l = FamiliesPage.ByCheckLine(("Required FMC parameters present (by GUID)", 0, 2, 344));
            await Assert.That(l.Status).IsEqualTo("2 pass");
            await Assert.That(l.Kind).IsEqualTo(ChipKind.Warn);
            await Assert.That(FamiliesPage.ByCheckLine(("Keynote set", 0, 10, 0)).Status).IsEqualTo("Pass");
            await Assert.That(FamiliesPage.ByCheckLine(("Keynote set", 3, 7, 0)).Status).IsEqualTo("3 fail");
        }
    }
}
