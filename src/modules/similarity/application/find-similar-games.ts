import type { GameRepository } from '../../catalog/domain/game-repository.js';
import {
  findSimilarGames,
  MAX_SIMILAR,
  type SimilarGame,
  type SimilarityCandidate,
} from '../domain/similarity.js';

/**
 * Подбор похожих игр среди уже собранных.
 *
 * Ничего не вычисляет сам: правила лежат в domain, данные приходят через
 * порт репозитория. Отдельной таблицы для похожих игр нет — результат
 * считается по запросу.
 */

export interface FindSimilarGamesDeps {
  readonly games: GameRepository;
  /**
   * Предел числа рассматриваемых кандидатов.
   *
   * Каталог невелик, и полный перебор дёшев. Предел защищает от роста
   * стоимости запроса, если каталог существенно вырастет.
   */
  readonly candidateLimit: number;
}

export interface FindSimilarGamesParams {
  readonly gameId: string;
  readonly limit?: number;
}

export class FindSimilarGamesUseCase {
  constructor(private readonly deps: FindSimilarGamesDeps) {}

  async execute(params: FindSimilarGamesParams): Promise<readonly SimilarGame[]> {
    const target = await this.deps.games.findForSimilarity(params.gameId);
    // Игры нет — похожих тоже нет; ошибкой это не является
    if (!target) return [];

    const candidates = await this.deps.games.listForSimilarity({
      excludeGameId: params.gameId,
      limit: this.deps.candidateLimit,
    });

    return findSimilarGames(
      target as SimilarityCandidate,
      candidates as readonly SimilarityCandidate[],
      params.limit ?? MAX_SIMILAR,
    );
  }
}
