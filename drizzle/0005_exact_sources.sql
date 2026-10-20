UPDATE words SET source='https://api.datamuse.com/words?sp=' || word || '&md=d&max=1' WHERE language='English' AND source='https://api.datamuse.com/words';
