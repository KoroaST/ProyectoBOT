const { EmbedBuilder } = require('discord.js');
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  entersState,
} = require('@discordjs/voice');
const { spawn } = require('child_process');
const ytSearch = require('yt-search');
const SpotifyWebApi = require('spotify-web-api-node');
require('dotenv').config();

// --- Configurar Spotify API ---
const spotifyApi = new SpotifyWebApi({
  clientId: process.env.SPOTIFY_CLIENT_ID,
  clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
});

// --- Colores ---
const COLORS = {
  PRIMARY: '#7289DA',
  SUCCESS: '#43B581',
  ERROR: '#F04747',
  WARNING: '#FAA61A',
  SPOTIFY: '#1DB954',
  YOUTUBE: '#FF0000',
};

// --- Mapas para manejar conexiones y players ---
const connections = new Map();
const players = new Map();
const disconnectTimeouts = new Map();


// --- Sistema de Queue ---
const queues = new Map(); // guildId -> { songs: [], current: null, isPlaying: false }

// --- Info actual de reproducción por guild (para nowplaying, etc.) ---
const currentPlayInfo = new Map();

/**
 * Obtiene y setea el token de Spotify
 */
const getSpotifyToken = async () => {
  try {
    const data = await spotifyApi.clientCredentialsGrant();
    spotifyApi.setAccessToken(data.body.access_token);
    console.log('✅ Token de Spotify obtenido');
  } catch (error) {
    console.error('❌ Error al obtener token de Spotify:', error.message);
    throw error;
  }
};

/**
 * Limpia conexiones y players de un guild
 * @param {string} guildId
 */
const cleanup = (guildId) => {
  const player = players.get(guildId);
  if (player) {
    player.stop();
    players.delete(guildId);
  }
  const connection = connections.get(guildId);
  if (connection) {
    connection.destroy();
    connections.delete(guildId);
  }
  currentPlayInfo.delete(guildId);
  queues.delete(guildId);
  console.log(`🧹 Limpieza completada para el servidor ${guildId}`);
};

/**
 * Obtiene un stream de audio usando yt-dlp
 * @param {string} url
 * @returns {stream.Readable}
 */
const getAudioStream = (url) => {
  const ytdlpProcess = spawn('yt-dlp', [
    '-f',
    'bestaudio',
    '-o',
    '-',
    '--no-playlist',
    '--quiet',
    '--no-warnings',
    '--prefer-free-formats',
    '--no-check-certificate',
    '--add-header',
    `cookie: ${process.env.YOUTUBE_COOKIE}`,
    '--add-header',
    'User-Agent: Mozilla/5.0',
    url,
  ]);

  return ytdlpProcess.stdout;
};

/**
 * Formatea duración en segundos a mm:ss
 * @param {number} seconds
 * @returns {string}
 */
const formatDuration = (seconds) => {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
};

/**
 * Reproduce la siguiente canción en la queue
 * @param {string} guildId 
 * @param {Object} channel - Canal de texto para enviar mensajes
 */


const playNext = async (guildId, channel) => {
  const queue = queues.get(guildId);

  if (!queue || queue.songs.length === 0) {
    if (disconnectTimeouts.has(guildId)) return;

    // Crear embed inicial de aviso
    const disconnectEmbed = new EmbedBuilder()
      .setColor(COLORS.WARNING)
      .setTitle('⏳ Canciones de espera vacía')
      .setDescription('La lista de canciones terminó, desconectando en 15 segundos si no se agrega más música...');

    // Enviar embed y guardar mensaje para editarlo después
    const sentMessage = await channel.send({ embeds: [disconnectEmbed] });

    const timeout = setTimeout(async () => {
      cleanup(guildId);

      // Editar embed para indicar desconexión finalizada
      const finishedEmbed = new EmbedBuilder()
        .setColor(COLORS.SUCCESS)
        .setTitle('✅ Conexión finalizada')
        .setDescription('La conexión fue finalizada por inactividad.');

      await sentMessage.edit({ embeds: [finishedEmbed] });

      disconnectTimeouts.delete(guildId);
    }, 15000);

    disconnectTimeouts.set(guildId, timeout);
    return;
  }

  // Si llega una nueva canción y hay timeout, cancelar desconexión
  if (disconnectTimeouts.has(guildId)) {
    clearTimeout(disconnectTimeouts.get(guildId));
    disconnectTimeouts.delete(guildId);
  }

  // Resto de tu código para reproducir la siguiente canción...
  const song = queue.songs.shift();
  queue.current = song;
  queue.isPlaying = true;

  const player = players.get(guildId);
  const connection = connections.get(guildId);

  if (!player || !connection) {
    console.error('Player o conexión no encontrados al reproducir siguiente canción');
    cleanup(guildId);
    return;
  }

  try {
    const stream = getAudioStream(song.url);
    const resource = createAudioResource(stream);
    player.play(resource);

    currentPlayInfo.set(guildId, {
      connection,
      player,
      title: song.title,
      url: song.url,
      duration: song.duration,
      thumbnail: song.thumbnail,
      requestedBy: song.requestedBy,
      source: song.source,
    });

    player.currentRequester = song.requesterId;

    if (channel) {
      const playEmbed = new EmbedBuilder()
        .setColor(song.source === 'Spotify → YouTube' ? COLORS.SPOTIFY : COLORS.YOUTUBE)
        .setTitle('🎶 Reproduciendo')
        .setDescription(`[${song.title}](${song.url})`)
        .addFields(
          { name: '⏱ Duración', value: formatDuration(song.duration), inline: true },
          { name: '🎵 Fuente', value: song.source, inline: true },
          { name: '📋 En Queue', value: `${queue.songs.length} canciones`, inline: true }
        )
        .setThumbnail(song.thumbnail)
        .setFooter({
          text: `Solicitado por ${song.requestedBy}`,
          iconURL: song.requestedByAvatar,
        })
        .setTimestamp();

      channel.send({ embeds: [playEmbed] });
    }
  } catch (error) {
    console.error('Error al reproducir siguiente canción:', error);
    if (channel) {
      channel.send('❌ Error al reproducir la siguiente canción. Continuando con la queue...');
    }
    setTimeout(() => playNext(guildId, channel), 1000);
  }
};

module.exports = {
  name: 'play',
  description: 'Reproduce una canción desde YouTube o Spotify',

  execute: async (message, args) => {
    const query = args.join(' ');
    if (!query) {
      const errorEmbed = new EmbedBuilder()
        .setColor(COLORS.ERROR)
        .setTitle('❌ Error')
        .setDescription('Debes proporcionar el nombre de una canción o una URL.')
        .addFields(
          { name: '📝 Uso', value: '`+play <nombre de canción>` o `+play <URL>`', inline: false },
          {
            name: '🎵 Ejemplos',
            value:
              '• `+play Bohemian Rhapsody`\n• `+play https://youtu.be/...`\n• `+play https://open.spotify.com/track/...`',
            inline: false,
          }
        )
        .setThumbnail('https://cdn.discordapp.com/emojis/853332077820706816.png')
        .setFooter({
          text: `Solicitado por ${message.author.tag}`,
          iconURL: message.author.displayAvatarURL(),
        })
        .setTimestamp();

      return message.reply({ embeds: [errorEmbed] });
    }

    const voiceChannel = message.member.voice.channel;
    if (!voiceChannel) {
      const voiceErrorEmbed = new EmbedBuilder()
        .setColor(COLORS.WARNING)
        .setTitle('🔊 Canal de Voz Requerido')
        .setDescription('Debes estar conectado a un canal de voz para reproducir música.')
        .addFields({ name: '💡 Tip', value: 'Únete a cualquier canal de voz e intenta nuevamente.', inline: false })
        .setThumbnail('https://cdn.discordapp.com/emojis/853332165956780073.png')
        .setFooter({
          text: `Solicitado por ${message.author.tag}`,
          iconURL: message.author.displayAvatarURL(),
        })
        .setTimestamp();

      return message.reply({ embeds: [voiceErrorEmbed] });
    }

    const loadingEmbed = new EmbedBuilder()
      .setColor(COLORS.PRIMARY)
      .setTitle('🔍 Buscando música...')
      .setDescription('⏳ Estoy buscando tu canción, por favor espera...')
      .addFields({ name: '🎯 Búsqueda', value: `\`\`\`${query}\`\`\``, inline: false })
      .setThumbnail('https://i.gifer.com/ZZ5H.gif')
      .setFooter({
        text: `Solicitado por ${message.author.tag}`,
        iconURL: message.author.displayAvatarURL(),
      })
      .setTimestamp();

    const loadingMessage = await message.reply({ embeds: [loadingEmbed] });

    let url = '',
      title = query,
      duration = 0,
      thumbnail = '',
      source = 'YouTube';

    const spotifyTrackRegex = /https?:\/\/open\.spotify\.com\/track\/([a-zA-Z0-9]+)/;

    try {
      if (spotifyTrackRegex.test(query)) {
        // --- Spotify Track ---
        await getSpotifyToken();

        const trackId = query.match(spotifyTrackRegex)[1];
        const track = await spotifyApi.getTrack(trackId);

        if (!track.body) {
          const notFoundEmbed = new EmbedBuilder()
            .setColor(COLORS.ERROR)
            .setTitle('❌ No encontrado')
            .setDescription('No se pudo encontrar la canción en Spotify.')
            .setFooter({
              text: `Solicitado por ${message.author.tag}`,
              iconURL: message.author.displayAvatarURL(),
            })
            .setTimestamp();

          return loadingMessage.edit({ embeds: [notFoundEmbed] });
        }

        const trackName = track.body.name;
        const artistName = track.body.artists[0].name;
        title = `${trackName} - ${artistName}`;
        source = 'Spotify → YouTube';

        // Buscar en YouTube
        const results = await ytSearch(`${trackName} ${artistName}`);

        if (!results.videos.length) {
          const noResultsEmbed = new EmbedBuilder()
            .setColor(COLORS.ERROR)
            .setTitle('❌ Sin resultados')
            .setDescription('No se encontraron resultados en YouTube para esta canción de Spotify.')
            .setFooter({
              text: `Solicitado por ${message.author.tag}`,
              iconURL: message.author.displayAvatarURL(),
            })
            .setTimestamp();

          return loadingMessage.edit({ embeds: [noResultsEmbed] });
        }

        url = results.videos[0].url;
        title = results.videos[0].title;
        duration = results.videos[0].duration.seconds;
        thumbnail = results.videos[0].thumbnail;
      } else {
        // --- Búsqueda directa en YouTube ---
        const results = await ytSearch(query);

        if (!results.videos.length) {
          const noResultsEmbed = new EmbedBuilder()
            .setColor(COLORS.ERROR)
            .setTitle('❌ Sin resultados')
            .setDescription('No se encontraron resultados para tu búsqueda.')
            .addFields({
              name: '💡 Sugerencias',
              value: '• Verifica la ortografía\n• Intenta con palabras clave diferentes\n• Usa el nombre del artista',
              inline: false,
            })
            .setFooter({
              text: `Solicitado por ${message.author.tag}`,
              iconURL: message.author.displayAvatarURL(),
            })
            .setTimestamp();

          return loadingMessage.edit({ embeds: [noResultsEmbed] });
        }

        url = results.videos[0].url;
        title = results.videos[0].title;
        duration = results.videos[0].duration.seconds;
        thumbnail = results.videos[0].thumbnail;
      }

      // Crear objeto de canción
      const song = {
        title,
        url,
        duration,
        thumbnail,
        requestedBy: message.author.tag,
        requesterId: message.author.id,
        requestedByAvatar: message.author.displayAvatarURL(),
        source,
      };

      // Inicializar queue si no existe
      if (!queues.has(message.guild.id)) {
        queues.set(message.guild.id, {
          songs: [],
          current: null,
          isPlaying: false,
        });
      }

      const queue = queues.get(message.guild.id);

      // --- Conectar al canal de voz si no está conectado ---
      let connection = connections.get(message.guild.id);
      if (!connection || connection.state.status === VoiceConnectionStatus.Destroyed) {
        connection = joinVoiceChannel({
          channelId: voiceChannel.id,
          guildId: voiceChannel.guild.id,
          adapterCreator: voiceChannel.guild.voiceAdapterCreator,
        });
        connections.set(message.guild.id, connection);
        await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
      }

      // --- Crear o usar audio player ---
      let player = players.get(message.guild.id);
      if (!player) {
        player = createAudioPlayer();
        players.set(message.guild.id, player);

        // Evento cuando la canción termina
        player.on(AudioPlayerStatus.Idle, () => {
          console.log(`🎵 Canción terminó en servidor ${message.guild.id}`);
          // Reproducir siguiente canción en la queue
          playNext(message.guild.id, message.channel);
        });

        player.on('error', (error) => {
          console.error('Error en AudioPlayer:', error);
          message.channel.send('❌ Ocurrió un error en la reproducción. Continuando con la queue...');
          // Intentar con la siguiente canción
          setTimeout(() => playNext(message.guild.id, message.channel), 1000);
        });

        connection.subscribe(player);
      }

      // Si no hay nada reproduciéndose, reproducir inmediatamente
      if (!queue.isPlaying && queue.songs.length === 0) {
        queue.current = song;
        queue.isPlaying = true;

        // Obtener stream y crear recurso
        const stream = getAudioStream(url);
        const resource = createAudioResource(stream);
        player.play(resource);

        // Guardar el requester en el player para los comandos de control
        player.currentRequester = message.author.id;

        // Actualizar info actual
        currentPlayInfo.set(message.guild.id, {
          connection,
          player,
          title,
          url,
          duration,
          thumbnail,
          requestedBy: message.author.tag,
          source,
        });

        // Mostrar embed de reproducción
        const playEmbed = new EmbedBuilder()
          .setColor(source === 'Spotify → YouTube' ? COLORS.SPOTIFY : COLORS.YOUTUBE)
          .setTitle('🎶 Reproduciendo')
          .setDescription(`[${title}](${url})`)
          .addFields(
            { name: '⏱ Duración', value: formatDuration(duration), inline: true },
            { name: '🔊 Canal', value: voiceChannel.name, inline: true },
            { name: '🎵 Fuente', value: source, inline: true }
          )
          .setThumbnail(thumbnail)
          .setFooter({
            text: `Solicitado por ${message.author.tag}`,
            iconURL: message.author.displayAvatarURL(),
          })
          .setTimestamp();

        await loadingMessage.edit({ embeds: [playEmbed] });
      } else {
        // Agregar a la queue
        queue.songs.push(song);

        const queueEmbed = new EmbedBuilder()
          .setColor(COLORS.SUCCESS)
          .setTitle('📋 Agregado a la Queue')
          .setDescription(`[${title}](${url})`)
          .addFields(
            { name: '⏱ Duración', value: formatDuration(duration), inline: true },
            { name: '📍 Posición en Queue', value: `#${queue.songs.length}`, inline: true },
            { name: '🎵 Fuente', value: source, inline: true }
          )
          .setThumbnail(thumbnail)
          .setFooter({
            text: `Solicitado por ${message.author.tag}`,
            iconURL: message.author.displayAvatarURL(),
          })
          .setTimestamp();

        await loadingMessage.edit({ embeds: [queueEmbed] });
      }
    } catch (error) {
      console.error('Error en comando play:', error);
      const errorEmbed = new EmbedBuilder()
        .setColor(COLORS.ERROR)
        .setTitle('❌ Error inesperado')
        .setDescription('Hubo un problema al intentar reproducir la canción.')
        .setFooter({
          text: `Solicitado por ${message.author.tag}`,
          iconURL: message.author.displayAvatarURL(),
        })
        .setTimestamp();

      loadingMessage.edit({ embeds: [errorEmbed] });
    }
  },

  /**
   * Devuelve la info actual de reproducción por guild
   * @param {string} guildId
   */
  getCurrentPlayInfo: (guildId) => currentPlayInfo.get(guildId),

  /**
   * Devuelve la queue de un guild
   * @param {string} guildId
   */
  getQueue: (guildId) => queues.get(guildId),

  // --- Exportar mapas para uso externo ---
  players,
  connections,
  queues,
  cleanup,
  playNext,
};