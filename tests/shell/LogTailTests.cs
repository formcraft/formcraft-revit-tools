using System;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading.Tasks;
using Formcraft.Shell.Services;

namespace Formcraft.Shell.Tests
{
    /// <summary>F10: the Log window reads the shared writer's source column, old six-column files, and only the end of a big file.</summary>
    public class LogTailTests
    {
        private static string NewFile(string text)
        {
            var path = Path.Combine(Path.GetTempPath(), "fmc-log-" + Guid.NewGuid().ToString("N") + ".csv");
            File.WriteAllText(path, text, Encoding.UTF8);
            return path;
        }

        [Test]
        public async Task An_old_six_column_file_reads_the_seventh_field_as_the_source()
        {
            var now = DateTime.UtcNow.ToString("o");
            var path = NewFile("timestamp,action,dry_run,target,result,detail\r\n" +
                               now + ",save_as,false,a.rvt,ok,\r\n" +
                               now + ",close,false,a.rvt,ok,,Pane\r\n" +
                               now + ",model_statistics,false,b.rvt,ok,,claude-ai\r\n");
            try
            {
                var rows = new CsvLogReader(path).Read();
                await Assert.That(string.Join(",", rows.Select(r => r.From))).IsEqualTo("claude-ai,Pane,Unknown");
            }
            finally { File.Delete(path); }
        }

        [Test]
        public async Task The_AI_filter_takes_any_named_client_and_leaves_unknown_rows_out()
        {
            var now = DateTime.UtcNow.ToString("o");
            var path = NewFile("timestamp,action,dry_run,target,result,detail,source\r\n" +
                               now + ",save_as,false,a.rvt,ok,,Pane\r\n" +
                               now + ",model_statistics,false,b.rvt,ok,,claude-ai\r\n" +
                               now + ",close,false,b.rvt,ok,,Unknown\r\n" +
                               now + ",close,false,b.rvt,ok,,\r\n");
            try
            {
                var (ai, pane, all) = Sta.Run(() =>
                {
                    var vm = new Formcraft.Shell.ViewModels.LogViewModel(new CsvLogReader(path), _ => { }, _ => { });
                    vm.Filter = "AI";
                    var a = vm.Rows.Count;
                    vm.Filter = "Pane clicks";
                    var p = vm.Rows.Count;
                    vm.Filter = "All";
                    return (a, p, vm.Rows.Count);
                });
                await Assert.That(ai).IsEqualTo(1);
                await Assert.That(pane).IsEqualTo(1);
                await Assert.That(all).IsEqualTo(4);
            }
            finally { File.Delete(path); }
        }

        [Test]
        public async Task A_big_file_reads_only_its_newest_rows_with_the_header_and_fast()
        {
            var sb = new StringBuilder("timestamp,action,dry_run,target,result,detail,source\r\n");
            var start = new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc);
            for (var i = 0; i < 60000; i++)
                sb.Append(start.AddMinutes(i).ToString("o")).Append(",fmc_qa.check,false,model-").Append(i)
                  .Append(".rvt,ok,\"a detail, with a comma\r\nand a line break\",Pane\r\n");
            var path = NewFile(sb.ToString());
            try
            {
                var reader = new CsvLogReader(path, 256 * 1024);
                var watch = System.Diagnostics.Stopwatch.StartNew();
                var rows = reader.Read();
                var ms = watch.ElapsedMilliseconds;

                await Assert.That(reader.LastReadWasPartial).IsTrue();
                await Assert.That(rows.Count).IsGreaterThan(100);
                await Assert.That(rows.Count).IsLessThan(60000);
                await Assert.That(rows[0].Document).IsEqualTo("model-59999.rvt");
                await Assert.That(rows.All(r => r.From == "Pane" && r.Tool == "fmc_qa.check" && r.Detail == "a detail, with a comma\nand a line break")).IsTrue();
                await Assert.That(ms).IsLessThan(1000);
            }
            finally { File.Delete(path); }
        }

        [Test]
        public async Task A_small_file_is_read_whole()
        {
            var path = NewFile("timestamp,action,dry_run,target,result,detail,source\r\n" + DateTime.UtcNow.ToString("o") + ",save_as,false,a.rvt,ok,,Pane\r\n");
            try
            {
                var reader = new CsvLogReader(path);
                var rows = reader.Read();
                await Assert.That(reader.LastReadWasPartial).IsFalse();
                await Assert.That(rows.Count).IsEqualTo(1);
            }
            finally { File.Delete(path); }
        }
    }
}
