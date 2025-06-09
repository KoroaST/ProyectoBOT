const { EmbedBuilder } = require('discord.js');

const COLORS = {
  PRIMARY: '#7289DA',
  SUCCESS: '#43B581',
  ERROR: '#F04747',
  WARNING: '#FAA61A',
  SPOTIFY: '#1DB954',
  YOUTUBE: '#FF0000',
};

module.exports = {
  name: 'play',
  description: 'Reproduce una canción desde YouTube o Spotify',

  execute: async (message, args, client) => {
    const query = args.join(' ');
    if (!query) {
      return message.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(COLORS.ERROR)
            .setTitle('❌ Error')
            .setDescription('Debes proporcionar el nombre de una canción o una URL.')
            .addFields(
              { name: '📝 Uso', value: '`+play <nombre de canción>` o `+play <URL>`' },
              { name: '🎵 Ejemplos', value: '• `+play Bohemian Rhapsody`\n• `+play https://youtu.be/...`' }
            )
            .setFooter({ text: `Solicitado por ${message.author.tag}`, iconURL: message.author.displayAvatarURL() })
            .setTimestamp(),
        ],
      });
    }

    const voiceChannel = message.member.voice.channel;
    if (!voiceChannel) {
      return message.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(COLORS.WARNING)
            .setTitle('🔊 Canal de Voz Requerido')
            .setDescription('Debes estar conectado a un canal de voz para reproducir música.')
            .setFooter({ text: `Solicitado por ${message.author.tag}`, iconURL: message.author.displayAvatarURL() })
            .setTimestamp(),
        ],
      });
    }

    // Verificar permisos
    const permissions = voiceChannel.permissionsFor(message.guild.members.me);
    if (!permissions.has(['Connect', 'Speak'])) {
      return message.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(COLORS.ERROR)
            .setTitle('❌ Sin permisos')
            .setDescription('No tengo permisos para conectarme o hablar en ese canal de voz.')
            .setTimestamp(),
        ],
      });
    }

    // Verificar si hay nodos conectados
    const connectedNodes = client.manager.nodes.filter(node => node.connected);
    if (connectedNodes.size === 0) {
      return message.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(COLORS.ERROR)
            .setTitle('❌ Sin conexión a Lavalink')
            .setDescription('No hay nodos de Lavalink disponibles. Inténtalo más tarde.')
            .setTimestamp(),
        ],
      });
    }

    const loadingMsg = await message.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(COLORS.PRIMARY)
          .setTitle('🔍 Buscando música...')
          .setDescription(`⏳ Buscando: \`${query}\``)
          .addFields({ name: 'Nodos activos', value: `${connectedNodes.size}/${client.manager.nodes.size}`, inline: true })
          .setTimestamp(),
      ],
    });

    try {
      // Crear o obtener player
      let player = client.manager.get(message.guild.id);
      
      if (!player) {
        player = client.manager.create({
          guild: message.guild.id,
          voiceChannel: voiceChannel.id,
          textChannel: message.channel.id,
          selfDeafen: true,
          volume: 80,
        });
      }

      // Conectar si no está conectado
      if (player.state !== 'CONNECTED') {
        await player.connect();
        console.log(`🔗 Conectado al canal de voz: ${voiceChannel.name}`);
      }

      // Buscar música
      const res = await client.manager.search(query, message.author);
      
      console.log(`🔍 Resultado de búsqueda:`, {
        loadType: res.loadType,
        tracksLength: res.tracks?.length || 0,
        playlistName: res.playlist?.name || 'N/A'
      });

      switch (res.loadType) {
        case 'NO_MATCHES':
          return loadingMsg.edit({
            embeds: [
              new EmbedBuilder()
                .setColor(COLORS.ERROR)
                .setTitle('❌ Sin resultados')
                .setDescription(`No encontré resultados para: \`${query}\``)
                .addFields({ name: '💡 Sugerencia', value: 'Intenta con palabras más específicas o una URL directa.' })
                .setFooter({ text: `Solicitado por ${message.author.tag}`, iconURL: message.author.displayAvatarURL() })
                .setTimestamp(),
            ],
          });

        case 'LOAD_FAILED':
          console.error('❌ Error al cargar:', res.exception);
          return loadingMsg.edit({
            embeds: [
              new EmbedBuilder()
                .setColor(COLORS.ERROR)
                .setTitle('❌ Error al buscar')
                .setDescription('Hubo un problema al buscar la canción. Inténtalo de nuevo.')
                .addFields({ name: 'Error', value: res.exception?.message || 'Error desconocido' })
                .setFooter({ text: `Solicitado por ${message.author.tag}`, iconURL: message.author.displayAvatarURL() })
                .setTimestamp(),
            ],
          });

        case 'PLAYLIST_LOADED':
          player.queue.add(res.tracks);
          await loadingMsg.edit({
            embeds: [
              new EmbedBuilder()
                .setColor(COLORS.SUCCESS)
                .setTitle('📃 Playlist añadida')
                .setDescription(`Se añadieron **${res.tracks.length}** canciones de **${res.playlist.name}** a la cola.`)
                .addFields(
                  { name: 'Posición en cola', value: `${player.queue.size - res.tracks.length + 1}-${player.queue.size}`, inline: true },
                  { name: 'Duración total', value: `~${Math.floor(res.tracks.reduce((acc, track) => acc + track.duration, 0) / 60000)} min`, inline: true }
                )
                .setFooter({ text: `Solicitado por ${message.author.tag}`, iconURL: message.author.displayAvatarURL() })
                .setTimestamp(),
            ],
          });
          break;

        case 'TRACK_LOADED':
        case 'SEARCH_RESULT':
          const track = res.tracks[0];
          player.queue.add(track);

          const queuePos = player.queue.size;
          const isFirst = queuePos === 1 && !player.playing;

          await loadingMsg.edit({
            embeds: [
              new EmbedBuilder()
                .setColor(COLORS.SUCCESS)
                .setTitle(isFirst ? '🎶 Reproduciendo ahora' : '✅ Añadida a la cola')
                .setDescription(`**[${track.title}](${track.uri})**`)
                .addFields(
                  { name: 'Duración', value: `${Math.floor(track.duration / 60000)}:${String(Math.floor((track.duration % 60000) / 1000)).padStart(2, '0')}`, inline: true },
                  { name: 'Autor', value: track.author || 'Desconocido', inline: true },
                  { name: 'Posición', value: isFirst ? 'Reproduciendo' : `${queuePos}`, inline: true }
                )
                .setThumbnail(track.thumbnail || null)
                .setFooter({ text: `Desde ${track.sourceName} • Solicitado por ${message.author.tag}`, iconURL: message.author.displayAvatarURL() })
                .setTimestamp(),
            ],
          });
          break;
      }

      // Iniciar reproducción si no está reproduciendo
      if (!player.playing && !player.paused && player.queue.size > 0) {
        await player.play();
        console.log('▶️ Iniciando reproducción');
      }

    } catch (error) {
      console.error('❌ Error en el comando play:', error);
      
      // Intentar destruir el player si hay error crítico
      const player = client.manager.get(message.guild.id);
      if (player && error.message.includes('connect')) {
        player.destroy();
      }

      await loadingMsg.edit({
        embeds: [
          new EmbedBuilder()
            .setColor(COLORS.ERROR)
            .setTitle('❌ Error inesperado')
            .setDescription('Hubo un problema al intentar reproducir la canción.')
            .addFields({ name: 'Detalles', value: `\`${error.message}\`` })
            .setFooter({ text: `Solicitado por ${message.author.tag}`, iconURL: message.author.displayAvatarURL() })
            .setTimestamp(),
        ],
      });
    }
  },
};
