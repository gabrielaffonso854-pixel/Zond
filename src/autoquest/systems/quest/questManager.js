// src/systems/quest/questManager.js

delete window.$;
let wpRequire = webpackChunkdiscord_app.push([[Symbol()], {}, (r) => r]);
webpackChunkdiscord_app.pop();

let ApplicationStreamingStore = Object.values(wpRequire.c).find(
	(x) => x?.exports?.Z?.__proto__?.getStreamerActiveStreamMetadata,
    ).exports.Z;
    let RunningGameStore = Object.values(wpRequire.c).find(
    	(x) => x?.exports?.ZP?.getRunningGames,
        ).exports.ZP;
        let QuestsStore = Object.values(wpRequire.c).find(
        	(x) => x?.exports?.Z?.__proto__?.getQuest,
            ).exports.Z;
            let ChannelStore = Object.values(wpRequire.c).find(
            	(x) => x?.exports?.Z?.__proto__?.getAllThreadsForParent,
                ).exports.Z;
                let GuildChannelStore = Object.values(wpRequire.c).find(
                	(x) => x?.exports?.ZP?.getSFWDefaultChannel,
                    ).exports.ZP;
                    let FluxDispatcher = Object.values(wpRequire.c).find(
                    	(x) => x?.exports?.Z?.__proto__?.flushWaitQueue,
                        ).exports.Z;
                        let api = Object.values(wpRequire.c).find((x) => x?.exports?.tn?.get).exports.tn;

                        function getActiveQuest() {
                        	return [...QuestsStore.quests.values()].find(
                            		(x) =>
                                    			x.id !== '1412491570820812933' &&
                                                			x.userStatus?.enrolledAt &&
                                                            			!x.userStatus?.completedAt &&
                                                                        			new Date(x.config.expiresAt).getTime() > Date.now(),
                                                                                    	);
                                                                                        }

                                                                                        module.exports = {
                                                                                        	ApplicationStreamingStore,
                                                                                            	RunningGameStore,
                                                                                                	QuestsStore,
                                                                                                    	ChannelStore,
                                                                                                        	GuildChannelStore,
                                                                                                            	FluxDispatcher,
                                                                                                                	api,
                                                                                                                    	getActiveQuest
                                                                                                                        };
                                                                                                                        