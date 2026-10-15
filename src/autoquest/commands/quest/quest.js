// src/commands/quest/quest.js
const { getActiveQuest } = require('../../systems/quest/questManager');
const { executeQuest } = require('../../systems/quest/questService');

module.exports = {
    name: 'quest',
        description: 'Inicia o auto-complete da quest ativa do Discord',
            async execute(message, args) {
                    const quest = getActiveQuest();
                            if (!quest) {
                                        return message.reply("Você não tem nenhuma quest ativa pendente!");
                                                }
                                                        message.reply(`Iniciando o processo para a quest: ${quest.config.messages.questName}`);
                                                                executeQuest(quest);
                                                                    }
                                                                    };
                                                                    