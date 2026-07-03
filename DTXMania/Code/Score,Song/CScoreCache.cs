using System;
using System.IO;
using System.Diagnostics;

namespace DTXMania
{
	/// <summary>
	/// <para>Resolves where the song-scan cache files (songs.db / songlist.db) are stored
	/// and how their validity is decided.</para>
	///
	/// <para>Historically the cache lived next to the executable and was only reused when
	/// Config.ini existed and reported a matching version. That coupling meant a read-only
	/// install folder (e.g. under "Program Files") could never persist Config.ini nor the
	/// cache, so every launch invalidated the cache and rescanned the whole song library.</para>
	///
	/// <para>This helper keeps the cache next to the executable when that folder is writable
	/// (fully backward compatible), but transparently redirects it to a per-user
	/// application-data folder when it is not. Cache validity is decided by a small stamp
	/// file written beside the cache, so it no longer depends on Config.ini being writable.</para>
	/// </summary>
	internal static class CScoreCache
	{
		public const string SONGS_DB_FILENAME = "songs.db";
		public const string SONGLIST_DB_FILENAME = "songlist.db";
		private const string CACHE_STAMP_FILENAME = "songcache.version";
		private const string APPDATA_SUBFOLDER = "DTXManiaNX";

		private static volatile string strCacheFolder = null;
		private static readonly object lockObj = new object();

		/// <summary>
		/// The folder used to read/write the scan cache. Resolved once, then memoized.
		/// </summary>
		public static string CacheFolder
		{
			get
			{
				if ( strCacheFolder != null )
					return strCacheFolder;

				lock ( lockObj )
				{
					if ( strCacheFolder == null )
						strCacheFolder = tResolveCacheFolder();
				}
				return strCacheFolder;
			}
		}

		private static string tResolveCacheFolder()
		{
			string exeFolder = CDTXMania.strEXEのあるフォルダ;

			// Prefer the executable folder so existing installs keep their songs.db in place.
			if ( tIsFolderWritable( exeFolder ) )
				return exeFolder;

			// The executable folder is read-only; redirect the cache to a writable
			// per-user folder so scan results can still be persisted between launches.
			try
			{
				string appData = Path.Combine(
					Environment.GetFolderPath( Environment.SpecialFolder.LocalApplicationData ),
					APPDATA_SUBFOLDER );

				if ( !Directory.Exists( appData ) )
					Directory.CreateDirectory( appData );

				Trace.TraceInformation( "The executable folder is not writable; the song scan cache has been redirected to: {0}", appData );
				return appData;
			}
			catch ( Exception e )
			{
				Trace.TraceWarning( "Failed to prepare the per-user cache folder; falling back to the executable folder. ({0})", e.Message );
				return exeFolder;
			}
		}

		private static bool tIsFolderWritable( string folder )
		{
			try
			{
				if ( string.IsNullOrEmpty( folder ) || !Directory.Exists( folder ) )
					return false;

				string probe = Path.Combine( folder, ".dtxcache_write_test.tmp" );
				using ( new FileStream( probe, FileMode.Create, FileAccess.Write, FileShare.None, 1, FileOptions.DeleteOnClose ) )
				{
					// Successful create+dispose (with DeleteOnClose) proves the folder is writable.
				}
				return true;
			}
			catch
			{
				return false;
			}
		}

		// Write paths always target the resolved (writable) cache folder.
		public static string SongsDBWritePath
		{
			get { return Path.Combine( CacheFolder, SONGS_DB_FILENAME ); }
		}
		public static string SongListDBWritePath
		{
			get { return Path.Combine( CacheFolder, SONGLIST_DB_FILENAME ); }
		}

		// Read paths prefer the resolved cache folder, but fall back to the legacy
		// executable-folder location so a pre-existing cache keeps working after upgrade.
		public static string SongsDBReadPath
		{
			get { return tResolveReadPath( SONGS_DB_FILENAME ); }
		}
		public static string SongListDBReadPath
		{
			get { return tResolveReadPath( SONGLIST_DB_FILENAME ); }
		}

		private static string tResolveReadPath( string filename )
		{
			string primary = Path.Combine( CacheFolder, filename );
			if ( File.Exists( primary ) )
				return primary;

			string legacy = CDTXMania.strEXEのあるフォルダ + filename;
			if ( File.Exists( legacy ) )
				return legacy;

			return primary;
		}

		private static string StampPath
		{
			get { return Path.Combine( CacheFolder, CACHE_STAMP_FILENAME ); }
		}

		/// <summary>
		/// <para>Returns whether the on-disk cache may be reused for this build.</para>
		/// <para>Validity is decided by a stamp file written alongside the cache after the
		/// previous scan finished. Because the stamp lives in the (writable) cache folder,
		/// this no longer depends on Config.ini being persisted, which is what previously
		/// forced a full rescan on every launch for read-only installs.</para>
		/// </summary>
		public static bool IsCacheValid()
		{
			try
			{
				string stampFile = StampPath;
				if ( File.Exists( stampFile ) )
				{
					string stamp = File.ReadAllText( stampFile ).Trim();
					return string.Equals( stamp, CDTXMania.VERSION, StringComparison.Ordinal );
				}

				// Backward compatibility: an install upgraded from a version without the
				// stamp file can still trust its existing cache when Config.ini reports a
				// matching version (the historical validity rule).
				if ( CDTXMania.ConfigIni != null &&
					!CDTXMania.ConfigIni.bConfigIniがないかDTXManiaのバージョンが異なる )
				{
					return true;
				}
			}
			catch ( Exception e )
			{
				Trace.TraceWarning( "Failed to read the song cache stamp. ({0})", e.Message );
			}
			return false;
		}

		/// <summary>
		/// Records the current build version beside the cache so the next launch can reuse it.
		/// Call this after the scan results (songs.db / songlist.db) have been saved.
		/// </summary>
		public static void UpdateStamp()
		{
			try
			{
				File.WriteAllText( StampPath, CDTXMania.VERSION );
			}
			catch ( Exception e )
			{
				Trace.TraceWarning( "Failed to write the song cache stamp. ({0})", e.Message );
			}
		}
	}
}
