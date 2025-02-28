// Note to potential API users:
// - If you want to do batch requests, it's probably better to just ask for
//   the data instead.
// - API is subject to change. Message us if you're using it so we avoid
//   breaking it in the future.

import dayjs from 'dayjs';
import express from 'express';
import relativeTime from 'dayjs/plugin/relativeTime.js';
dayjs.extend(relativeTime);

import Config from './util/config.js';
import bancho from './bancho.js';
import databases from './database.js';
import {get_rank} from './elo_mmr.js';
import {init_lobby as init_ranked_lobby} from './ranked.js';
import {init_lobby as init_collection_lobby} from './collection.js';


const stmts = {};

const USER_NOT_FOUND = new Error('User not found. Have you played a game in a ranked lobby yet?');
USER_NOT_FOUND.code = 404;


async function get_leaderboard_page(page_num) {
  const PLAYERS_PER_PAGE = 20;

  const month_ago_tms = Date.now() - (30 * 24 * 3600 * 1000);
  const total_players = stmts.playercount.get(month_ago_tms);

  // Fix user-provided page number
  const nb_pages = Math.ceil(total_players.nb / PLAYERS_PER_PAGE);
  if (page_num <= 0 || isNaN(page_num)) {
    page_num = 1;
    // TODO: redirect?
  }
  if (page_num > nb_pages) {
    page_num = nb_pages;
    // TODO: redirect?
  }

  const offset = (page_num - 1) * PLAYERS_PER_PAGE;
  const res = stmts.leaderboard_page.all(month_ago_tms, PLAYERS_PER_PAGE, offset);
  const data = {
    nb_ranked_players: total_players.nb,
    the_one: false,
    players: [],
    page: page_num,
    max_pages: nb_pages,
  };

  // Players
  let ranking = offset + 1;
  if (ranking == 1) {
    data.the_one = {
      user_id: res[0].user_id,
      username: res[0].username,
      ranking: ranking,
      elo: Math.round(res[0].elo),
    };

    res.shift();
    ranking++;
  }

  for (const user of res) {
    data.players.push({
      user_id: user.user_id,
      username: user.username,
      ranking: ranking,
      elo: Math.round(user.elo),
    });

    ranking++;
  }

  return data;
}

async function get_user_profile(user_id) {
  const user = stmts.user_by_id.get(user_id);
  if (!user) {
    throw USER_NOT_FOUND;
  }

  const month_ago_tms = Date.now() - (30 * 24 * 3600 * 1000);
  return {
    username: user.username,
    user_id: user.user_id,
    games_played: user.games_played,
    elo: Math.round(user.elo),
    rank: get_rank(user.elo),
    is_ranked: (user.games_played > 5 && user.last_contest_tms > month_ago_tms),
  };
}

async function get_user_matches(user_id, page_num) {
  const user = stmts.user_by_id.get(user_id);
  if (!user) {
    throw USER_NOT_FOUND;
  }

  const MATCHES_PER_PAGE = 20;

  // Fix user-provided page number
  const nb_pages = Math.ceil(user.games_played / MATCHES_PER_PAGE);
  if (page_num <= 0 || isNaN(page_num)) {
    page_num = 1;
    // TODO: redirect?
  }
  if (page_num > nb_pages) {
    page_num = nb_pages;
    // TODO: redirect?
  }

  const data = {
    matches: [],
    page: page_num,
    max_pages: nb_pages,
  };

  const offset = (page_num - 1) * MATCHES_PER_PAGE;
  const scores = stmts.user_scores_page.all(user.user_id, MATCHES_PER_PAGE, offset);
  for (const score of scores) {
    const elo_change = Math.round(score.new_elo - score.old_elo);

    let placement = 0;
    const contest_scores = stmts.contest_scores.all(score.contest_id);
    for (const contest_score of contest_scores) {
      placement++;
      if (contest_score.user_id == user.user_id) {
        break;
      }
    }

    data.matches.push({
      map: stmts.fetch_map.get(score.map_id),
      placement: placement,
      players_in_match: contest_scores.length,
      elo_change: elo_change,
      positive: elo_change > 0,
      negative: elo_change < 0,
      time: dayjs(score.tms).fromNow(),
      tms: Math.round(score.tms / 1000),
    });
  }

  return data;
}

async function register_routes(app) {
  stmts.fetch_map = databases.ranks.prepare('SELECT * FROM map WHERE id = ?');
  stmts.playercount = databases.ranks.prepare(`
    SELECT COUNT(*) AS nb FROM user
    WHERE games_played > 4 AND last_contest_tms > ?`,
  );
  stmts.leaderboard_page = databases.ranks.prepare(`
    SELECT * FROM user
    WHERE games_played > 4 AND last_contest_tms > ?
    ORDER BY elo DESC LIMIT ? OFFSET ?`,
  );
  stmts.user_by_id = databases.ranks.prepare(`
    SELECT * FROM user
    WHERE user_id = ?`,
  );
  stmts.user_scores_page = databases.ranks.prepare(`
    SELECT * FROM score
    WHERE user_id = ?
    ORDER BY tms DESC LIMIT ? OFFSET ?`,
  );
  stmts.contest_scores = databases.ranks.prepare(`
    SELECT user_id FROM score
    WHERE contest_id = ?
    ORDER BY score DESC`,
  );

  app.get('/api/leaderboard/:pageNum/', async (req, http_res) => {
    try {
      const data = await get_leaderboard_page(parseInt(req.params.pageNum, 10));
      http_res.set('Cache-control', 'public, max-age=60');
      http_res.json(data);
    } catch (err) {
      http_res.status(err.code).json({error: err.message});
    }
  });

  app.get('/api/user/:userId/', async (req, http_res) => {
    try {
      const data = await get_user_profile(parseInt(req.params.userId, 10));
      http_res.set('Cache-control', 'public, max-age=60');
      http_res.json(data);
    } catch (err) {
      http_res.status(err.code).json({error: err.message});
    }
  });

  app.get('/api/user/:userId/matches/:pageNum/', async (req, http_res) => {
    try {
      const data = await get_user_matches(
          parseInt(req.params.userId, 10),
          parseInt(req.params.pageNum, 10),
      );
      http_res.set('Cache-control', 'public, max-age=60');
      http_res.json(data);
    } catch (err) {
      http_res.status(err.code).json({error: err.message});
    }
  });

  app.get('/api/lobbies/', async (req, http_res) => {
    const lobbies = [];

    for (const lobby of bancho.joined_lobbies) {
      lobbies.push({
        bancho_id: lobby.invite_id,
        nb_players: lobby.nb_players,
        name: lobby.name,
        mode: lobby.data.mode,
        scorev2: lobby.data.is_scorev2,
        creator_name: lobby.data.creator,
        creator_id: lobby.data.creator_osu_id,
        map: lobby.map,
      });
    }

    http_res.json(lobbies);
  });

  app.post('/api/create-lobby/', express.json(), async (req, http_res) => {
    if (!req.user_id) {
      http_res.status(403).json({error: 'You need to be authenticated to create a lobby.'});
      return;
    }

    for (const lobby of bancho.joined_lobbies) {
      if (lobby.data.creator_osu_id == req.user_id) {
        http_res.status(401).json({error: 'You have already created a lobby.'});
        return;
      }
    }

    let user = stmts.user_by_id.get(req.user_id);
    if (!user) {
      // User has never played in a ranked lobby.
      // But we still can create a lobby for them :)
      user = {
        id: req.user_id,
        username: 'New user',
      };
    }
    let lobby = null;
    if (req.body.match_id) {
      try {
        console.info(`Joining lobby of ${user.username}...`);
        lobby = await bancho.join(`#mp_${req.body.match_id}`);
      } catch (err) {
        http_res.status(400).json({error: `Failed to join the lobby`, details: err.message});
        return;
      }
    } else {
      try {
        console.info(`Creating lobby for ${user.username}...`);
        lobby = await bancho.make(Config.IS_PRODUCTION ? `New o!RL lobby` : `test lobby`);
        await lobby.send(`!mp addref #${req.user_id}`);
      } catch (err) {
        http_res.status(400).json({error: 'Could not create the lobby', details: err.message});
        return;
      }
    }

    try {
      lobby.created_just_now = true;
      lobby.data.creator = user.username;
      lobby.data.creator_osu_id = req.user_id;

      if (req.body.title && req.body.type != 'ranked') {
        await lobby.send(`!mp name ${req.body.title}`);
        lobby.name = req.body.title;
      }

      if (req.body.star_rating == 'fixed') {
        lobby.data.min_stars = req.body.min_stars;
        lobby.data.max_stars = req.body.max_stars;
        lobby.data.fixed_star_range = true;
      } else {
        lobby.data.fixed_star_range = false;
      }

      if (req.body.type == 'ranked') {
        lobby.data.is_scorev2 = req.body.scoring_system == 'scorev2';
        await init_ranked_lobby(lobby);
      } else {
        lobby.data.collection_id = req.body.collection_id;
        await init_collection_lobby(lobby);
      }
    } catch (err) {
      http_res.status(503).json({error: 'An error occurred while creating the lobby', details: err.message});
      return;
    }

    http_res.status(200).json({
      success: true,
      lobby: {
        bancho_id: lobby.invite_id,
        nb_players: lobby.nb_players,
        name: lobby.name,
        mode: lobby.data.mode,
        scorev2: lobby.data.is_scorev2,
        creator_name: lobby.data.creator,
        creator_id: lobby.data.creator_osu_id,
        map: lobby.map,
      },
    });
  });
}

export {
  register_routes,
};
