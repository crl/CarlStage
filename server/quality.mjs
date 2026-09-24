export function singleEpisodeOutlineWarning(section, episodeCount, validation) {
  return section === 'outline' && episodeCount === 1 &&
    /1 处违规/.test(validation) && /大爆点不在最后一集才首次出现/.test(validation) &&
    (validation.match(/质量门未过/g) || []).length === 1;
}
